// The OpenCode adapter (SW-385): `harness: opencode` init writes AGENTS.md, .agents/skills,
// the plugin and opencode.json; the generated plugin feeds werkmeister's hook commands on
// both OpenCode plugin APIs; sessions run over `opencode run`. The external binaries
// (`werkmeister`, `opencode`) are shell fakes on PATH; the plugin is the real generated file.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { harnessFor, harnessLayoutFor, parseHarnessId } from "./dist/harness/layout.js";
import { OPENCODE_PLUGIN_PATH, writeOpencodeHooks } from "./dist/harness/opencode/hooks.js";
import { opencodeAdapter } from "./dist/harness/opencode/index.js";
import { opencodeResumeCommand, opencodeSendArgs } from "./dist/harness/opencode/session.js";
import { turnStatus } from "./dist/harness/turn.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome, writeSessionState } from "./fixtures.mjs";

pinWerkmeisterRoot();
process.env.WERKMEISTER_ROOT = path.join(import.meta.dirname, "..", "..", "apps", "cli");

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const script = (file, body) => {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
};
const workspace = (harness) => {
  const root = tmp("oc-ws-");
  fs.mkdirSync(path.join(root, ".werkmeister"));
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
    `task: OpenCode run\nwork_type: feature\ncontext_strategy: jit\n${harness ? `harness: ${harness}\n` : ""}`,
  );
  return root;
};

/** A fake `werkmeister` on PATH that logs `<cmd> <stdin>` and denies the command named in $DENY. */
function fakeWerkmeister() {
  const bin = tmp("oc-bin-");
  const log = path.join(bin, "calls.log");
  script(
    path.join(bin, "werkmeister"),
    `in=$(cat); printf '%s %s\\n' "$2" "$in" >> "${log}"
[ "$2" = "$DENY" ] && printf '%s\\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by '"$2"'"}}'
[ "$2" = "$BLOCK" ] && printf '%s\\n' '{"decision":"block","reason":"workspace is paused"}'
exit 0`,
  );
  const calls = () =>
    fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((l) => {
            const i = l.indexOf(" ");
            return { cmd: l.slice(0, i), input: JSON.parse(l.slice(i + 1)) };
          })
      : [];
  return { bin, calls, reset: () => fs.rmSync(log, { force: true }) };
}

async function withPath(dir, fn) {
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:/usr/bin:/bin`;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved;
    delete process.env.DENY;
  }
}

async function loadPlugin(root) {
  writeOpencodeHooks(root);
  const file = path.join(root, OPENCODE_PLUGIN_PATH);
  return (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)).default;
}

test("parseHarnessId accepts opencode", () => {
  assert.equal(parseHarnessId("opencode"), "opencode");
  assert.throws(() => parseHarnessId("cursor"), /claude, mcp, codex, opencode/);
});

test("jit init on opencode: AGENTS.md, .agents/skills, plugin, opencode.json, no .claude/, partial hooks named", async () => {
  const std = tmp("oc-std-");
  const root = workspace("opencode");
  try {
    fs.mkdirSync(path.join(std, "comments"));
    fs.writeFileSync(
      path.join(std, "comments", "STANDARD.md"),
      '---\ndomain: comments\nuniversal: 1\napplies_to:\n  - "**/*"\nphase: [implement]\nsummary: why\n---\n\n# Comments\n',
    );
    const reporter = collectingReporter();
    await withSandboxHome(() => withReporter(reporter, () => initWorkspace({}, root)), {
      config: `overrides:\n  standards_dir: ${std}\n`,
    });

    assert.equal(harnessLayoutFor(root).id, "opencode");
    const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agentsMd, /generated for OpenCode/);
    assert.match(agentsMd, /Session-start context and auto-stop do not run/);
    assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")), "CLAUDE.md written");
    assert.ok(!fs.existsSync(path.join(root, ".claude")), ".claude/ written");
    assert.ok(!fs.existsSync(path.join(root, ".devcontainer")), "Claude devcontainer written");
    assert.ok(
      fs.readdirSync(path.join(root, ".agents", "skills")).some((s) => s.startsWith("w9r-")),
    );
    assert.match(
      fs.readFileSync(path.join(root, OPENCODE_PLUGIN_PATH), "utf8"),
      /^\/\/ Managed by werkmeister/,
    );
    const config = JSON.parse(fs.readFileSync(path.join(root, "opencode.json"), "utf8"));
    assert.deepEqual(Object.keys(config.mcp), ["werkmeister"]);
    assert.equal(config.mcp.werkmeister.type, "remote");
    assert.match(config.mcp.werkmeister.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.deepEqual(config.mcp.werkmeister.headers, {
      Authorization: "Bearer {file:.werkmeister/token}",
    });
    assert.equal(config.permission.bash["werkmeister infra down*"], "deny");
    assert.equal(config.permission.bash["w9r machine setup*"], "deny");
    assert.equal(config.permission.bash["gh pr merge*"], "deny");
    const partial = reporter
      .text()
      .split("\n")
      .filter((l) =>
        /hooks: partial on opencode \(session-start context, auto-stop do not run\)/.test(l),
      );
    assert.equal(partial.length, 1, reporter.text());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});

test("writeOpencodeHooks keeps the person's opencode.json keys and leaves a non-JSON file alone", () => {
  const root = tmp("oc-cfg-");
  try {
    const file = path.join(root, "opencode.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        theme: "x",
        mcp: { other: { type: "local" } },
        permission: { bash: "ask" },
      }),
    );
    withReporter(collectingReporter(), () => writeOpencodeHooks(root));
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(config.theme, "x");
    // The person's catch-all stays, first, so werkmeister's denies match last and win.
    assert.equal(Object.keys(config.permission.bash)[0], "*");
    assert.equal(config.permission.bash["*"], "ask");
    assert.deepEqual(Object.keys(config.mcp).sort(), ["other", "werkmeister"]);

    const jsonc = '{\n  // mine\n  "theme": "y"\n}\n';
    fs.writeFileSync(file, jsonc);
    const reporter = collectingReporter();
    withReporter(reporter, () => writeOpencodeHooks(root));
    assert.equal(fs.readFileSync(file, "utf8"), jsonc);
    assert.match(reporter.text(), /opencode\.json is not plain JSON/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plugin, V1 API: edits go to gate and agent-state, a pr-guard deny blocks bash, idle is Stop", async () => {
  const root = tmp("oc-v1-");
  const empty = tmp("oc-empty-");
  const wm = fakeWerkmeister();
  try {
    const plugin = await loadPlugin(root);
    const hooks = await plugin.server({ directory: root });
    await withPath(wm.bin, async () => {
      await hooks["tool.execute.before"](
        { tool: "edit", sessionID: "s1" },
        { args: { filePath: "/x/a.ts", oldString: "a" } },
      );
      assert.deepEqual(
        wm.calls().map((c) => c.cmd),
        ["gate", "agent-state"],
      );
      const [gate] = wm.calls();
      assert.equal(gate.input.hook_event_name, "PreToolUse");
      assert.equal(gate.input.tool_name, "Edit");
      assert.equal(gate.input.tool_input.file_path, "/x/a.ts");
      assert.equal(gate.input.session_id, "s1");
      assert.equal(gate.input.cwd, root);

      wm.reset();
      process.env.DENY = "pr-guard";
      await assert.rejects(
        hooks["tool.execute.before"](
          { tool: "bash", sessionID: "s1" },
          { args: { command: "gh pr create" } },
        ),
        /denied by pr-guard/,
      );
      assert.deepEqual(wm.calls()[0].input.tool_input, { command: "gh pr create" });
      delete process.env.DENY;

      wm.reset();
      const patchText = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch";
      await hooks["tool.execute.before"](
        { tool: "apply_patch", sessionID: "s1" },
        { args: { patchText } },
      );
      assert.equal(wm.calls()[0].cmd, "gate");
      assert.equal(wm.calls()[0].input.tool_name, "apply_patch");
      assert.deepEqual(wm.calls()[0].input.tool_input, { command: patchText });

      process.env.BLOCK = "agent-state";
      await assert.rejects(hooks["chat.message"]({ sessionID: "s1" }), /workspace is paused/);
      delete process.env.BLOCK;

      wm.reset();
      await hooks.event({
        event: {
          type: "session.status",
          properties: { sessionID: "s1", status: { type: "idle" } },
        },
      });
      await hooks.event({
        event: {
          type: "session.status",
          properties: { sessionID: "s1", status: { type: "busy" } },
        },
      });
      assert.deepEqual(
        wm.calls().map((c) => c.input.hook_event_name),
        ["Stop"],
      );
    });
    // No werkmeister on PATH: the plugin must not get in the way.
    await withPath(empty, () =>
      hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: "ls" } }),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(wm.bin, { recursive: true, force: true });
  }
});

test("plugin, V2 API: a gate deny throws from execute.before, subscribed events reach agent-state", async () => {
  const root = tmp("oc-v2-");
  const wm = fakeWerkmeister();
  try {
    const plugin = await loadPlugin(root);
    assert.equal(plugin.id, "werkmeister");
    const toolHooks = {};
    const sessionHooks = {};
    let release;
    const done = new Promise((r) => (release = r));
    const events = [
      // OpenCode 2.2.5's own names; a started turn is already covered by the prompt hook.
      { type: "session.execution.started", data: { sessionID: "s2" } },
      { type: "permission.asked", data: { sessionID: "s2", title: "Run rm -rf?" } },
      { type: "session.execution.succeeded", data: { sessionID: "s2" } },
    ];
    const ctx = {
      location: { directory: root },
      tool: { hook: async (name, fn) => (toolHooks[name] = fn) },
      session: { hook: async (name, fn) => (sessionHooks[name] = fn) },
      event: {
        subscribe: async function* () {
          for (const e of events) yield e;
          release();
        },
      },
    };
    await withPath(wm.bin, async () => {
      const cleanup = await plugin.setup(ctx);
      await done;
      assert.deepEqual(
        wm.calls().map((c) => c.input.hook_event_name),
        ["Notification", "Stop"],
      );
      assert.equal(wm.calls()[0].input.notification_type, "permission_prompt");
      assert.equal(wm.calls()[0].input.message, "Run rm -rf?");

      wm.reset();
      process.env.DENY = "gate";
      await assert.rejects(
        toolHooks["execute.before"]({
          tool: "write",
          sessionID: "s2",
          input: { filePath: "/x/b.ts" },
        }),
        /denied by gate/,
      );
      assert.equal(wm.calls()[0].input.tool_name, "Write");
      delete process.env.DENY;

      // 2.2.5 names its shell tool `shell`; it reaches the PR guard like Claude's Bash.
      wm.reset();
      await toolHooks["execute.before"]({
        tool: "shell",
        sessionID: "s2",
        input: { command: "gh pr create" },
      });
      assert.deepEqual(
        wm.calls().map((c) => [c.cmd, c.input.tool_name, c.input.tool_input.command]),
        [
          ["pr-guard", "Bash", "gh pr create"],
          ["agent-state", "Bash", "gh pr create"],
        ],
      );

      wm.reset();
      await sessionHooks.prompt({ sessionID: "s2", prompt: { text: "hi" } });
      assert.equal(wm.calls()[0].input.hook_event_name, "UserPromptSubmit");
      process.env.BLOCK = "agent-state";
      await assert.rejects(sessionHooks.prompt({ sessionID: "s2" }), /workspace is paused/);
      delete process.env.BLOCK;
      cleanup();
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(wm.bin, { recursive: true, force: true });
  }
});

test("opencode argv: model only in provider/model form, session, --auto only unattended", () => {
  assert.deepEqual(opencodeSendArgs("hi", null, "sonnet"), ["run", "--format", "json", "hi"]);
  assert.deepEqual(
    opencodeSendArgs("hi", "ses_1", "anthropic/claude-sonnet-5-5", { unattended: true }),
    [
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-sonnet-5-5",
      "--session",
      "ses_1",
      "--auto",
      "hi",
    ],
  );
  assert.equal(
    opencodeResumeCommand("ses_1", "sonnet", "go on"),
    "opencode --session 'ses_1' --prompt 'go on'",
  );
});

test("sessions over a fake opencode: run, list, export, agent state; harnessFor dispatches by workspace", async () => {
  const root = workspace("opencode");
  const other = tmp("oc-other-");
  const bin = tmp("oc-oc-");
  const extra = [];
  const ws = (h) => {
    const d = workspace(h);
    extra.push(d);
    return d;
  };
  const saved = process.env.OPENCODE_BIN;
  try {
    const real = fs.realpathSync(root);
    // The shapes `session list --format json` and `session export` print on OpenCode 2.2.5.
    const list = [
      { id: "ses_old", title: "old", directory: real, created: 1, updated: 1_700_000_000_000 },
      { id: "ses_new", title: "new", directory: root, created: 2, updated: 1_800_000_000_000 },
      { id: "ses_elsewhere", title: "x", directory: other, updated: 1_900_000_000_000 },
    ];
    const exported = {
      info: { id: "ses_new" },
      messages: [
        { type: "user", time: { created: 1_800_000_000_000 }, text: "run tests" },
        {
          type: "assistant",
          time: { created: 1_800_000_001_000 },
          content: [
            { type: "text", text: "Running." },
            { type: "tool", name: "shell", state: { input: { command: "npm test\n--watch" } } },
          ],
        },
        { type: "idle", outcome: "succeeded" },
      ],
    };
    fs.writeFileSync(path.join(bin, "list.json"), JSON.stringify(list));
    fs.writeFileSync(path.join(bin, "export.json"), JSON.stringify(exported));
    process.env.OPENCODE_BIN = script(
      path.join(bin, "opencode"),
      `case "$1" in
  session) case "$2" in
    list) cat "${bin}/list.json" ;;
    export) [ "$3" = ses_new ] && cat "${bin}/export.json" ;;
  esac ;;
  run) printf '%s\\n' "$@" > "${bin}/run.args" ;;
esac`,
    );

    assert.equal(harnessFor(root), opencodeAdapter);
    assert.equal(harnessFor(ws(null)).id, "claude");
    // mcp keeps Claude's (idle) session readers, as on main (SW-189).
    assert.equal(harnessFor(ws("mcp")).id, "claude");
    assert.equal(harnessFor(ws("nonsense")).id, "claude");

    const sessions = await opencodeAdapter.listSessions(root);
    assert.deepEqual(
      sessions.map((s) => [s.sessionId, s.isNewest]),
      [
        ["ses_new", true],
        ["ses_old", false],
      ],
    );
    const t = await opencodeAdapter.transcript(root, 20);
    assert.equal(t.sessionId, "ses_new");
    assert.equal(t.sessionCount, 2);
    assert.equal(t.updatedAt, new Date(1_800_000_000_000).toISOString());
    assert.deepEqual(
      t.messages.map((m) => [m.role, m.text]),
      [
        ["user", "run tests"],
        ["assistant", "Running."],
        ["tool", "shell: npm test"],
      ],
    );
    assert.equal((await opencodeAdapter.transcript(root, 1)).messages.length, 1);
    assert.equal(await opencodeAdapter.sessionStartDir(root, "ses_old"), root);
    assert.equal(await opencodeAdapter.sessionStartDir(root, "ses_gone"), null);

    const result = await opencodeAdapter.sendTurn("oc-key", root, "hello", "ses_new", null, {
      wait: true,
    });
    assert.deepEqual(result, { denied: [] });
    assert.equal(turnStatus("oc-key").state, "done");
    // The headless turn's own `working` record (its Stop was lost on exit) reads as done.
    writeSessionState(root, "working");
    assert.equal((await opencodeAdapter.agentSignal("oc-key", root, null)).signal.agent, "done");
    fs.rmSync(path.join(root, ".werkmeister", "sessions"), { recursive: true });
    assert.deepEqual(fs.readFileSync(path.join(bin, "run.args"), "utf8").trim().split("\n"), [
      "run",
      "--format",
      "json",
      "--session",
      "ses_new",
      "hello",
    ]);

    assert.equal((await opencodeAdapter.agentSignal("idle-key", root, null)).signal.agent, "idle");
    writeSessionState(root, "needs-you", { question: "Merge?", at: "2026-11-05T00:00:00.000Z" });
    const { signal } = await opencodeAdapter.agentSignal("idle-key", root, null);
    assert.equal(signal.agent, "needs-you");
    assert.equal(signal.question, "Merge?");
  } finally {
    if (saved === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = saved;
    for (const d of [root, other, bin, ...extra]) fs.rmSync(d, { recursive: true, force: true });
  }
});
