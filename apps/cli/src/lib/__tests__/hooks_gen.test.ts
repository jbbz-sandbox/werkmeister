/**
 * The SessionStart hook is rewritten in place across sandbox versions, and the
 * only thing tying a new command to the old one it replaces is `_HOOK_MARKER`
 * appearing in both. Reword the command without it and `_isManaged` stops
 * recognising the existing entry: the merge appends instead of replacing, and
 * every already-inited workspace silently runs two SessionStart hooks.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SESSION_START_COMMAND, writeWorkspaceHooks } from "../hooks_gen.js";

/** The shape shipped before skills self-healing — what real workspaces hold. */
const PRIOR_COMMAND = "command -v sandbox >/dev/null 2>&1 && sandbox notes context || true";

let tmp: string;

function settingsWith(sessionStart: unknown[]): string {
  const root = fs.mkdtempSync(path.join(tmp, "ws-"));
  fs.mkdirSync(path.join(root, ".claude"));
  fs.writeFileSync(
    path.join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SessionStart: sessionStart } }),
  );
  return root;
}

function sessionStartOf(root: string): any[] {
  const raw = fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8");
  return JSON.parse(raw).hooks.SessionStart;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hooks-gen-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("writeWorkspaceHooks", () => {
  it("replaces a prior managed entry rather than appending a second", () => {
    const root = settingsWith([{ hooks: [{ type: "command", command: PRIOR_COMMAND }] }]);

    writeWorkspaceHooks(root);

    const entries = sessionStartOf(root);
    expect(entries).toHaveLength(1);
    expect(entries[0].hooks[0].command).toBe(SESSION_START_COMMAND);
  });

  // The marker check that bites: a command missing `_HOOK_MARKER` still replaces
  // the *old* entry once, then goes unrecognised forever after. Only a second
  // pass over the entry this version wrote catches that.
  it("stays at one entry when the next version merges over it", () => {
    const root = settingsWith([{ hooks: [{ type: "command", command: PRIOR_COMMAND }] }]);

    writeWorkspaceHooks(root);
    writeWorkspaceHooks(root);

    expect(sessionStartOf(root)).toHaveLength(1);
  });

  it("leaves a hook the developer added alongside it", () => {
    const mine = { hooks: [{ type: "command", command: "echo mine" }] };
    const root = settingsWith([mine, { hooks: [{ type: "command", command: PRIOR_COMMAND }] }]);

    writeWorkspaceHooks(root);

    const entries = sessionStartOf(root);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(mine);
  });

  it("repairs stale skill projections without writing to the context window", () => {
    expect(SESSION_START_COMMAND).toContain("sandbox skills check");
    expect(SESSION_START_COMMAND).toContain("sandbox skills sync");
    // Only `notes context` may reach stdout — see the comment on _SKILLS_SELF_HEAL.
    expect(SESSION_START_COMMAND).not.toMatch(/sandbox skills (check|sync)(?! >\/dev\/null)/);
  });
});
