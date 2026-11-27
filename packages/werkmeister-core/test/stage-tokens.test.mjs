// SW-1100: usage.json splits a run's tokens by the ICM stage window each turn falls in.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

// Transcripts, the event log and prices are read under HOME: this file's own, never the caller's.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "stage-tokens-home-"));
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = path.join(home, ".werkmeister", "config.yaml");
after(() => fs.rmSync(home, { recursive: true, force: true }));
const { buildUsageSnapshot, stageTokens } = await import("../dist/usage_snapshot.js");

const git = (cwd, env, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, ...env },
  });
const commitAt = (ws, iso, file) => {
  fs.writeFileSync(path.join(ws, file), "x");
  git(ws, {}, "add", "-A");
  git(ws, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, "commit", "-q", "-m", file);
};
const tok = (input, output, cacheCreation, cacheRead) => ({
  input,
  output,
  cacheCreation,
  cacheRead,
});
const turn = (timestamp, model, [i, o, cc, cr]) =>
  JSON.stringify({
    type: "assistant",
    timestamp,
    message: {
      model,
      usage: {
        input_tokens: i,
        output_tokens: o,
        cache_creation_input_tokens: cc,
        cache_read_input_tokens: cr,
      },
    },
  });

test("a transcript over two stages: each turn counts in its stage's window, later ones after the stages", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "stage-tokens-ws-"));
  try {
    for (const s of ["01_research", "02_spec", "03_implement"])
      fs.mkdirSync(path.join(ws, "stages", s, "output"), { recursive: true });
    git(ws, {}, "init", "-q");
    git(ws, {}, "config", "user.email", "t@example.com");
    git(ws, {}, "config", "user.name", "t");
    commitAt(ws, "2026-11-01T09:00:00Z", "README.md");
    commitAt(ws, "2026-11-01T10:00:00Z", "stages/01_research/output/inventory.md");
    commitAt(ws, "2026-11-01T11:00:00Z", "stages/02_spec/output/spec.md");

    const project = path.join(home, ".claude", "projects", ws.replace(/[^a-zA-Z0-9]/g, "-"));
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(
      path.join(project, "s1.jsonl"),
      [
        JSON.stringify({ type: "user", timestamp: "2026-11-01T09:30:00.000Z" }),
        turn("2026-11-01T09:40:00.000Z", "claude-opus-5-5", [1, 2, 3, 4]),
        // On the stage's end: still that stage.
        turn("2026-11-01T10:00:00.000Z", "claude-opus-5-5", [5, 6, 7, 8]),
        turn("2026-11-01T10:30:00.000Z", "claude-sonnet-5-5", [10, 20, 30, 40]),
        turn("2026-11-01T11:30:00.000Z", "claude-opus-5-5", [100, 200, 300, 400]),
      ].join("\n"),
    );

    const s = await buildUsageSnapshot(ws, "ws", {}, "shipped", "2026-11-01T12:00:00.000Z");
    assert.equal(s.schema, 1);
    assert.deepEqual(
      s.stages.map((x) => [x.stage, x.tokens]),
      [
        ["01_research", tok(6, 8, 10, 12)],
        ["02_spec", tok(10, 20, 30, 40)],
        ["03_implement", null],
      ],
    );
    assert.deepEqual(s.unstagedTokens, tok(100, 200, 300, 400));
    assert.deepEqual(s.totals, tok(116, 228, 340, 452));
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test("stageTokens: a stage committed before the one ahead of it gets zero; with no stage reached, all is unstaged", () => {
  const at = (iso) => Date.parse(iso);
  const stages = [
    { stage: "01", finishedAt: "2026-11-01T11:00:00.000Z", minutes: 60 },
    { stage: "02", finishedAt: "2026-11-01T10:00:00.000Z", minutes: 0 },
    { stage: "03", finishedAt: "2026-11-01T12:00:00.000Z", minutes: 60 },
  ];
  const r = stageTokens(stages, [
    [at("2026-11-01T10:30:00Z"), tok(1, 0, 0, 0)],
    [at("2026-11-01T11:30:00Z"), tok(0, 1, 0, 0)],
  ]);
  assert.deepEqual(
    r.stages.map((x) => [x.stage, x.tokens]),
    [
      ["01", tok(1, 0, 0, 0)],
      ["02", tok(0, 0, 0, 0)],
      ["03", tok(0, 1, 0, 0)],
    ],
  );
  assert.deepEqual(r.unstaged, tok(0, 0, 0, 0));

  const none = stageTokens(
    [{ stage: "01", finishedAt: null, minutes: null }],
    [[at("2026-11-01T10:30:00Z"), tok(1, 2, 3, 4)]],
  );
  assert.deepEqual(none.stages[0].tokens, null);
  assert.deepEqual(none.unstaged, tok(1, 2, 3, 4));
});
