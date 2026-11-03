// SW-195: which app claude-resume / pr-reconcile open, and the URI the VS Code extension handles.

import assert from "node:assert/strict";
import { test } from "node:test";

import { claudeLauncher, claudeLaunchUri, reconcileLaunchUri } from "./dist/launcher.js";

test("launcher: WERKMEISTER_LAUNCHER wins, then TERM_PROGRAM=vscode, else Terminal", () => {
  assert.equal(claudeLauncher({}), "terminal");
  assert.equal(claudeLauncher({ TERM_PROGRAM: "vscode" }), "vscode");
  assert.equal(claudeLauncher({ TERM_PROGRAM: "Apple_Terminal" }), "terminal");
  assert.equal(
    claudeLauncher({ WERKMEISTER_LAUNCHER: "terminal", TERM_PROGRAM: "vscode" }),
    "terminal",
  );
  assert.equal(claudeLauncher({ WERKMEISTER_LAUNCHER: "vscode" }), "vscode");
  assert.equal(claudeLauncher({ WERKMEISTER_LAUNCHER: "junk", TERM_PROGRAM: "vscode" }), "vscode");
});

test("claude URI: mode from the session, prompt only when given, query-encoded", () => {
  assert.equal(
    claudeLaunchUri({ workspace: "ws-1", sessionId: null }),
    "vscode://jbbz.werkmeister-vscode/claude?workspace=ws-1&mode=new",
  );
  assert.equal(
    claudeLaunchUri({ workspace: "ws-1", sessionId: "abc-123", prompt: "start the run & go" }),
    "vscode://jbbz.werkmeister-vscode/claude?workspace=ws-1&mode=resume&session=abc-123&prompt=start+the+run+%26+go",
  );
  assert.equal(
    claudeLaunchUri({ workspace: "ws-1", sessionId: null, prompt: "" }),
    "vscode://jbbz.werkmeister-vscode/claude?workspace=ws-1&mode=new",
  );
});

test("reconcile URI carries the slug", () => {
  assert.equal(
    reconcileLaunchUri("my-repo-42"),
    "vscode://jbbz.werkmeister-vscode/reconcile?slug=my-repo-42",
  );
});
