// SW-1246: a grant landed 21 s into an open AskUserQuestion. The band holds a nudge while a turn runs, so its
// "continue" waited 5.5 h, and the prompt after the answer deleted it as stale: the CLI session never heard.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-nudge-hook-"));
process.env.HOME = home;
process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "w9r", "config.yaml");
process.env.WERKMEISTER_DOCKER_BIN = "/nonexistent/docker";
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { writeNudge, nudgePath } = await import("../dist/agent_state.js");

const GRANTED = "Capacity freed: this workspace's containers are up. Continue where you left off.";

function workspace(name) {
  const dir = path.join(home, "features", name);
  fs.mkdirSync(path.join(dir, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".werkmeister", "workspace.yml"), "autonomous: false\n");
  return dir;
}

/** The hook entry as Claude Code runs it, in its own process. */
function hook(event) {
  const entry = new URL("../dist/agent_state.js", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { main } from "${entry}"; main();`],
    { input: JSON.stringify(event), encoding: "utf8", env: process.env },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("a grant during an open question reaches the session with the answer, once", () => {
  const dir = workspace("asked");
  const s = { cwd: dir, session_id: "s" };
  hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", ...s });
  writeNudge(dir, GRANTED); // the grant, while the question waits on the person

  // Another tool finishing mid-turn (a background job) is not the answer: the nudge waits.
  assert.equal(hook({ hook_event_name: "PostToolUse", tool_name: "Bash", ...s }), null);
  assert.ok(fs.existsSync(nudgePath(dir)));
  // A subagent's hook carries the parent's session id, but its context isn't the conversation's.
  assert.equal(
    hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", agent_id: "a1", ...s }),
    null,
  );
  assert.ok(fs.existsSync(nudgePath(dir)));

  const answered = hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion", ...s });
  assert.deepEqual(answered, {
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: GRANTED },
  });
  assert.equal(fs.existsSync(nudgePath(dir)), false);
  // The next prompt (sw-741's came 12 s after the answer) finds nothing left to send.
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", ...s }), null);
});

test("a nudge still pending at the next prompt rides on it instead of being dropped", () => {
  const dir = workspace("prompted");
  writeNudge(dir, GRANTED);
  const out = hook({ hook_event_name: "UserPromptSubmit", cwd: dir, session_id: "s" });
  assert.equal(out.hookSpecificOutput.additionalContext, GRANTED);
  assert.equal(fs.existsSync(nudgePath(dir)), false);
});
