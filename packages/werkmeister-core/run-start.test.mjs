// SW-153: the one start prompt and run limits block, and start_session's arguments built from workspace.yml.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildStartArgs,
  deferMachineSteps,
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

test("the run limits point at the redacted config view", () => {
  assert.ok(RUN_LIMITS.includes("`werkmeister machine config`"));
  assert.ok(RUN_LIMITS.includes("jira.api_token"));
});

// SW-296: the SW-278 brief told the run to `registry sync`, which the run limits forbid.
const SW278 =
  "- Edit the fragment. After editing, run `werkmeister registry sync` so the generated registry picks up the change.";

test("a registry sync step is dropped and moved to an after-merge note (SW-296)", () => {
  const out = deferMachineSteps(
    `## Where to start\n\n${SW278}\n\n## Acceptance criteria\n\n- [ ] Tests pass.`,
  );
  assert.ok(out.startsWith("## Where to start\n\n- Edit the fragment.\n\n## Acceptance criteria"));
  assert.doesNotMatch(out, /run `werkmeister registry sync`/);
  assert.match(
    out,
    /\n## After merge\n\n.*\n- Registry sync: the next `werkmeister registry sync` after merge/,
  );
});

test("proxy-reload, linking and global installs get the same handling, one note each (SW-296)", () => {
  const out = deferMachineSteps(
    [
      "- Run `werkmeister infra proxy-reload` to apply it.",
      "1. `npm link` the CLI. Then check it.",
      "- [ ] run `pnpm add -g foo`.",
      "Then run `npm install --global bar` and `npm link` again.",
    ].join("\n"),
  );
  assert.equal(out.split("## After merge")[0], "1. Then check it.\n\n");
  const notes = out.split("\n").filter((l) => /^- [A-Z]/.test(l));
  assert.deepEqual(
    notes.map((l) => l.split(":")[0]),
    ["- Proxy reload", "- Linking the CLI", "- Global installs"],
  );
});

test("mentions that aren't run steps are kept, and a clean prompt comes back unchanged (SW-296)", () => {
  const prose = [
    'The ticket says "run `werkmeister registry sync`" and that broke SW-278.',
    "The gate never needs werkmeister registry sync during a run.",
    "Run `npm install` in the worktree.",
  ].join("\n");
  assert.equal(deferMachineSteps(prose), prose);
});

test("deferring twice changes nothing more (SW-296)", () => {
  const once = deferMachineSteps(`${SW278}\n- Run \`npm link\`.`);
  assert.equal(deferMachineSteps(once), once);
});

test("the run limits name the commands the brief defers (SW-296)", () => {
  for (const cmd of [
    "`npm link`",
    "install -g",
    "werkmeister infra proxy-reload",
    "`~/.werkmeister`",
  ])
    assert.ok(RUN_LIMITS.includes(cmd), cmd);
});
