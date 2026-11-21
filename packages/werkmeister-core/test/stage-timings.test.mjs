// SW-774: a stage's end was its newest output mtime, so re-editing an earlier stage's
// file later made the next stage's minutes negative. SW-777: it is the stage.done event, else that commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { recordEvent } from "../dist/metrics.js";
import { stageTimings } from "../dist/usage_snapshot.js";

// stage.done events go to a log of this file's own, never ~/.werkmeister.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stages-home-"));
process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "config.yaml");
after(() => fs.rmSync(home, { recursive: true, force: true }));

// The host's signing and hooks would make the fixture's commits prompt or fail.
const git = (cwd, env, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, ...env },
  });

function workspace() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stages-"));
  for (const s of ["01_reproduce", "02_fix", "03_exercise"]) {
    fs.mkdirSync(path.join(ws, "stages", s, "output"), { recursive: true });
    fs.writeFileSync(path.join(ws, "stages", s, "output", ".gitkeep"), "");
  }
  git(ws, {}, "init", "-q");
  git(ws, {}, "config", "user.email", "t@example.com");
  git(ws, {}, "config", "user.name", "t");
  return ws;
}

const commitAt = (ws, iso, file, body) => {
  fs.writeFileSync(path.join(ws, file), body);
  git(ws, {}, "add", "-A");
  git(ws, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, "commit", "-q", "-m", file);
};
const head = (ws) => git(ws, {}, "rev-parse", "HEAD").toString().trim();

test("a stage ends at the commit that first filled its output, not its newest mtime", () => {
  const ws = workspace();
  try {
    commitAt(ws, "2026-11-01T09:00:00Z", "README.md", "init"); // .gitkeep files land before any stage
    commitAt(ws, "2026-11-01T10:00:00Z", "stages/01_reproduce/output/repro.md", "a");
    commitAt(ws, "2026-11-01T11:00:00Z", "stages/02_fix/output/fix.md", "b");
    // 01's file edited (and re-committed) after 02 finished: the case that went negative.
    commitAt(ws, "2026-11-01T12:00:00Z", "stages/01_reproduce/output/repro.md", "a2");

    const t = stageTimings(ws, "2026-11-01T09:30:00Z");
    assert.deepEqual(
      t.map((s) => [s.stage, s.finishedAt, s.minutes]),
      [
        ["01_reproduce", "2026-11-01T10:00:00.000Z", 30],
        ["02_fix", "2026-11-01T11:00:00.000Z", 60],
        ["03_exercise", null, null],
      ],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("stages committed together end at that one commit, whatever their files' mtimes", () => {
  const ws = workspace();
  try {
    const at = (file, iso) => {
      fs.writeFileSync(path.join(ws, file), "x");
      fs.utimesSync(path.join(ws, file), new Date(iso), new Date(iso));
    };
    at("stages/01_reproduce/output/repro.md", "2026-11-01T10:00:00Z");
    at("stages/02_fix/output/fix.md", "2026-11-01T11:00:00Z");
    git(ws, {}, "add", "-A");
    const iso = "2026-11-01T12:00:00Z";
    git(ws, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, "commit", "-q", "-m", "01 + 02");

    const t = stageTimings(ws, "2026-11-01T09:30:00Z");
    assert.deepEqual(
      t.map((s) => s.minutes),
      [150, 0, null],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("outside git, or for uncommitted output, a stage ends at its oldest output mtime", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stages-"));
  try {
    const out = (s, f) => path.join(ws, "stages", s, "output", f);
    for (const s of ["01_reproduce", "02_fix"])
      fs.mkdirSync(path.dirname(out(s, "x")), { recursive: true });
    const at = (f, iso) => {
      fs.writeFileSync(f, "x");
      fs.utimesSync(f, new Date(iso), new Date(iso));
    };
    at(out("01_reproduce", "repro.md"), "2026-11-01T10:00:00Z");
    at(out("01_reproduce", "late-note.md"), "2026-11-01T12:00:00Z");
    at(out("02_fix", "fix.md"), "2026-11-01T11:00:00Z");

    const t = stageTimings(ws, "2026-11-01T09:30:00Z");
    assert.deepEqual(
      t.map((s) => s.minutes),
      [30, 60],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a stage.done event sets its stage's end; a stage without one falls back to its commit", () => {
  const ws = workspace();
  try {
    commitAt(ws, "2026-11-01T10:00:00Z", "stages/01_reproduce/output/repro.md", "a");
    const sha = head(ws);
    commitAt(ws, "2026-11-01T11:00:00Z", "stages/02_fix/output/fix.md", "b");
    const at = "2026-11-01T09:45:00.000Z";
    const done = (workspace, stage, commit) =>
      recordEvent({ event: "stage.done", workspace, stage, commit }, at);
    done(path.basename(ws), "01_reproduce", sha);
    // Another workspace's event for the same stage name is not this one's.
    done("other", "02_fix", sha);
    // A reused name's earlier run: its commit is not in this history, and 03 has no output here.
    done(path.basename(ws), "03_exercise", "0".repeat(40));

    const t = stageTimings(ws, "2026-11-01T09:30:00Z");
    assert.deepEqual(
      t.map((s) => [s.stage, s.finishedAt, s.minutes]),
      [
        ["01_reproduce", at, 15],
        ["02_fix", "2026-11-01T11:00:00.000Z", 75],
        ["03_exercise", null, null],
      ],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("a later stage committed before an earlier one gets 0 minutes, never negative", () => {
  const ws = workspace();
  try {
    commitAt(ws, "2026-11-01T10:00:00Z", "stages/02_fix/output/fix.md", "b");
    commitAt(ws, "2026-11-01T11:00:00Z", "stages/01_reproduce/output/repro.md", "a");
    commitAt(ws, "2026-11-01T12:00:00Z", "stages/03_exercise/output/run.md", "c");
    // Edited after every stage is done: changes nothing.
    commitAt(ws, "2026-11-01T13:00:00Z", "stages/01_reproduce/output/repro.md", "a2");

    const t = stageTimings(ws, "2026-11-01T09:30:00Z");
    assert.deepEqual(
      t.map((s) => s.minutes),
      [90, 0, 60],
    );
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
