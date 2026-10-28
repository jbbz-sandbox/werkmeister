// SW-153: the one start prompt and run limits block, and start_session's arguments built from workspace.yml.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildStartArgs,
  GATE_LINE,
  INTERACTIVE_LINE,
  RUN_LIMITS,
  startArgs,
  startPrompt,
} from "./dist/sandbox.js";

const W = { name: "sw-9-demo", issueId: "SW-9", task: "Do it", model: null, autonomous: false };

test("an autonomous prompt carries every run limit and no interactive line", () => {
  const p = startPrompt(true);
  assert.ok(p.startsWith("start the run\n"));
  for (const line of RUN_LIMITS.split("\n")) assert.ok(p.includes(line), line);
  assert.ok(p.includes(GATE_LINE));
  assert.ok(!p.includes(INTERACTIVE_LINE));
});

test("an interactive prompt carries the interactive and gate lines, not the limits", () => {
  const p = startPrompt(false);
  assert.ok(p.startsWith("start the run\n"));
  assert.ok(p.includes(INTERACTIVE_LINE));
  assert.ok(p.includes(GATE_LINE));
  assert.ok(!p.includes("Tests never call the real Jira"));
});

test("buildStartArgs: title, model only when set, and a background of at least 80 characters", () => {
  const a = buildStartArgs(W);
  assert.equal(a.title, "SW-9 Do it");
  assert.ok(!("model" in a));
  assert.equal(a.prompt, startPrompt(false));
  assert.equal(buildStartArgs({ ...W, model: "sonnet" }).model, "sonnet");
  assert.equal(buildStartArgs({ ...W, autonomous: true }).prompt, startPrompt(true));

  const bare = buildStartArgs({ ...W, name: "x", issueId: null, task: null });
  assert.equal(bare.title, "x");
  assert.ok(bare.background.length >= 80, bare.background);
  assert.match(bare.background, /CLAUDE\.md.*\.werkmeister\/issue\.md/);
  assert.match(a.background, /for SW-9/);

  assert.equal(buildStartArgs({ ...W, task: "t".repeat(100) }).title.length, 59);
});

test("buildStartArgs cuts a long title at a word, not mid-word (SW-157)", () => {
  const task = "Add the missing record branch directory to the workspace pane cards";
  const full = `SW-9 ${task}`;
  const { title } = buildStartArgs({ ...W, task });
  const kept = title.replace(/…$/, "");
  assert.ok(title.length < 60, title);
  assert.ok(full.startsWith(kept) && full[kept.length] === " ", title);
});

test("startArgs reads the workspace's own workspace.yml", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "start-args-"));
  try {
    fs.mkdirSync(path.join(dir, ".werkmeister"));
    fs.writeFileSync(
      path.join(dir, ".werkmeister", "workspace.yml"),
      'issue_id: SW-7\ntask: "Fix the thing"\nmodel: sonnet\nautonomous: true\n',
    );
    const a = await startArgs(dir);
    assert.equal(a.title, "SW-7 Fix the thing");
    assert.equal(a.model, "sonnet");
    assert.equal(a.prompt, startPrompt(true));
    assert.match(a.background, new RegExp(`\`${path.basename(dir)}\` for SW-7`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
