// SW-774: a stage's end was its newest output mtime, so re-editing an earlier stage's
// file later made the next stage's minutes negative.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stageTimings } from "../dist/usage_snapshot.js";

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

test("stages committed together keep their own times from their files", () => {
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
      [30, 60, null],
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
