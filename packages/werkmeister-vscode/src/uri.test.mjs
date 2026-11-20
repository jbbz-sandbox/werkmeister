// SW-195: the URI handler's parsing and quoting, and that it round-trips what core builds.

import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeLaunchUri, reconcileLaunchUri } from "werkmeister-core/launcher";
import {
  parseLaunchUri,
  sessionCommand,
  sessionTabName,
  shellQuote,
} from "../out/harness/claude/uri.js";

const parts = (uri) => {
  const u = new URL(uri);
  return [u.pathname, u.search.slice(1)];
};

test("each mode builds its claude command", () => {
  assert.deepEqual(parseLaunchUri("/claude", "workspace=ws&mode=new"), {
    kind: "claude",
    workspace: "ws",
    command: "claude",
  });
  assert.equal(
    parseLaunchUri("/claude", "workspace=ws&mode=continue").command,
    "claude --continue",
  );
  assert.equal(
    parseLaunchUri("/claude", "workspace=ws&mode=resume&session=abc-1").command,
    "claude --resume abc-1",
  );
});

// SW-384: a codex workspace gets codex commands behind the same /claude URI.
test("each mode builds its codex command for a codex workspace", () => {
  const launch = "WERKMEISTER_MCP_TOKEN=$(cat .werkmeister/token) codex";
  const cmd = (q) => parseLaunchUri("/claude", q, "codex", launch).command;
  assert.equal(cmd("workspace=ws&mode=new"), launch);
  assert.equal(cmd("workspace=ws&mode=continue"), `${launch} resume --last`);
  assert.equal(cmd("workspace=ws&mode=resume&session=019a-ff"), `${launch} resume 019a-ff`);
  assert.equal(cmd("workspace=ws&mode=new&prompt=hi"), `${launch} 'hi'`);
  assert.equal(sessionCommand("codex", "continue"), "codex resume --last");
  assert.equal(sessionCommand("mcp", "continue"), "claude --continue");
});

test("the prompt is one single-quoted argv, whatever it holds", () => {
  const prompt = 'it\'s $(id) `x` "y" && rm';
  const { command } = parseLaunchUri(
    "/claude",
    new URLSearchParams({ workspace: "ws", mode: "new", prompt }).toString(),
  );
  assert.equal(command, `claude ${shellQuote(prompt)}`);
  assert.equal(command, `claude 'it'\\''s $(id) \`x\` "y" && rm'`);
});

test("bad input throws instead of running anything", () => {
  assert.throws(() => parseLaunchUri("/run", "cmd=ls"), /Unknown werkmeister URI path/);
  assert.throws(() => parseLaunchUri("/claude", "mode=new"), /Missing workspace/);
  assert.throws(() => parseLaunchUri("/claude", "workspace=ws&mode=open"), /Unknown mode/);
  assert.throws(() => parseLaunchUri("/claude", "workspace=ws&mode=resume"), /Bad session id/);
  assert.throws(
    () => parseLaunchUri("/claude", "workspace=ws&mode=resume&session=a;rm"),
    /Bad session id/,
  );
  assert.throws(() => parseLaunchUri("/reconcile", "slug=../etc"), /Bad reconcile slug/);
  assert.throws(() => parseLaunchUri("/reconcile", "slug=repo"), /Bad reconcile slug/);
});

test("round-trips the URIs werkmeister-core builds", () => {
  assert.deepEqual(
    parseLaunchUri(
      ...parts(claudeLaunchUri({ workspace: "ws-1", sessionId: "s-1", prompt: "go" })),
    ),
    { kind: "claude", workspace: "ws-1", command: "claude --resume s-1 'go'" },
  );
  assert.deepEqual(
    parseLaunchUri(...parts(claudeLaunchUri({ workspace: "ws-1", sessionId: null }))),
    {
      kind: "claude",
      workspace: "ws-1",
      command: "claude",
    },
  );
  assert.deepEqual(parseLaunchUri(...parts(reconcileLaunchUri("my-repo-42"))), {
    kind: "reconcile",
    slug: "my-repo-42",
  });
});

test("SW-499: remote_control=1 names the matched workspace, never the query", () => {
  const rc = (query, matched, harness = "claude") =>
    parseLaunchUri("/claude", query, harness, "codex", matched).command;
  assert.equal(rc("workspace=ws&mode=new&remote_control=1", "ws"), "claude --remote-control 'ws'");
  assert.equal(
    rc("workspace=ws&mode=new&remote_control=1&prompt=hi", "ws"),
    "claude --remote-control 'ws' 'hi'",
  );
  // The handler matches by exact name, so a crafted name has no match.
  assert.throws(
    () => rc("workspace=ws%27%3Brm%20-rf%20~&mode=new&remote_control=1", undefined),
    /remote_control needs an existing workspace/,
  );
  const named = rc("workspace=evil&mode=new&remote_control=1", "ws");
  assert.equal(named, "claude --remote-control 'ws'");
  assert.doesNotMatch(named, /evil/);
  assert.throws(() => rc("workspace=ws&mode=new&remote_control=yes", "ws"), /Bad remote_control/);
  assert.equal(rc("workspace=ws&mode=new&remote_control=1", "ws", "codex"), "codex");
});

test("a session tab leads with the issue key so it matches the card (SW-864)", () => {
  assert.equal(sessionTabName("sw-864-vscode-ui-revamp"), "SW-864 · vscode-ui-revamp");
  assert.equal(sessionTabName("sandbox-110-repo-dir-drift"), "SANDBOX-110 · repo-dir-drift");
  assert.equal(sessionTabName("bwell"), "bwell");
  assert.equal(sessionTabName("jit-ws1"), "jit-ws1");
});

// SW-693: Continue brings a live session terminal forward instead of opening a second one.
test("liveSessionTerminal: the workspace's open session terminal, never an exited one", async () => {
  const { liveSessionTerminal } = await import("../out/harness/claude/uri.js");
  const name = sessionTabName("sw-693-continue");
  const live = { name, exitStatus: undefined };
  const exited = { name, exitStatus: { code: 0 } };
  const other = { name: sessionTabName("sw-1-other"), exitStatus: undefined };
  assert.equal(liveSessionTerminal([other, live], "sw-693-continue", "claude"), live);
  assert.equal(liveSessionTerminal([other], "sw-693-continue", "claude"), undefined);
  assert.equal(liveSessionTerminal([exited], "sw-693-continue", "claude"), undefined);
  const old = { name: "codex sw-693-continue", exitStatus: undefined };
  assert.equal(
    liveSessionTerminal([old], "sw-693-continue", "codex"),
    old,
    "a pre-SW-864 tab name",
  );
});
