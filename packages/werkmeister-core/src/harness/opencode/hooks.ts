/**
 * OpenCode's hook files (SW-385): a plugin that feeds OpenCode's events to werkmeister's
 * Claude-shaped hook commands, and the werkmeister MCP server in `opencode.json`.
 */
import fs from "node:fs";
import path from "node:path";
import { daemonPort } from "../../daemon_client.js";
import { warn } from "../../reporter.js";
import { AUTONOMOUS_DENY } from "../autonomous_deny.js";

export const OPENCODE_PLUGIN_PATH = ".opencode/plugins/werkmeister.js";

/**
 * One file for both plugin lines, which do not load each other's (OpenCode's migrate-v1
 * guide): V2 reads `id` + `setup`, V1 calls `server`. No imports beyond node builtins, as
 * the workspace has no node_modules. Each event becomes the stdin a Claude hook would get.
 */
export const OPENCODE_PLUGIN = `// Managed by werkmeister (SW-385): rewritten by workspace init and feature up; edits are lost.
import { spawn } from "node:child_process";

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "multiedit"]);

function run(cmd, payload) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn("werkmeister", ["internal", cmd], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve("");
    }
    child.on("error", () => resolve(""));
    child.stdout.on("data", (d) => (out += d));
    child.on("close", () => resolve(out));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

// A PreToolUse deny, or a UserPromptSubmit block (a paused or queued workspace).
function denial(stdout) {
  for (const line of stdout.split("\\n")) {
    try {
      const o = JSON.parse(line);
      const h = o && o.hookSpecificOutput;
      if (h && h.permissionDecision === "deny") return h.permissionDecisionReason || "Blocked by werkmeister.";
      if (o && o.decision === "block") return o.reason || "Blocked by werkmeister.";
    } catch {}
  }
  return null;
}

async function prompt(cwd, sessionId) {
  const reason = denial(await run("agent-state", { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd }));
  if (reason) throw new Error(reason);
}

async function before(cwd, sessionId, tool, args) {
  args = args || {};
  const base = { hook_event_name: "PreToolUse", session_id: sessionId, cwd };
  const checks = [];
  if ((tool === "apply_patch" || tool === "patch") && typeof args.patchText === "string") {
    // The gate reads each path out of the patch, as it does for Codex.
    const named = { ...base, tool_name: "apply_patch", tool_input: { command: args.patchText } };
    checks.push(["gate", named], ["agent-state", named]);
  } else if (EDIT_TOOLS.has(tool)) {
    const input = { ...args, file_path: args.filePath || args.file_path || args.path };
    const named = { ...base, tool_name: tool === "write" ? "Write" : "Edit", tool_input: input };
    checks.push(["gate", named], ["agent-state", named]);
  } else if (tool === "shell" || tool === "bash") {
    const named = { ...base, tool_name: "Bash", tool_input: { command: String(args.command || "") } };
    checks.push(["pr-guard", named], ["agent-state", named]);
  } else {
    const named = { ...base, tool_name: tool, tool_input: args };
    if (tool.endsWith("create_pull_request")) checks.push(["pr-guard", named]);
    checks.push(["agent-state", named]);
  }
  for (const [cmd, payload] of checks) {
    const reason = denial(await run(cmd, payload));
    if (reason) throw new Error(reason);
  }
}

const state = (cwd, sessionId, event, extra) =>
  run("agent-state", { hook_event_name: event, session_id: sessionId, cwd, ...extra });

// 2.2.5 events (V2): a turn runs from session.execution.started to .succeeded (.failed by
// analogy with session.tool.failed, not yet seen).
// The others are V1's names; 2.2.5 sends no session-created or session-ended event.
function onEvent(cwd, ev) {
  const p = (ev && (ev.properties || ev.data)) || ev || {};
  const id = p.sessionID || (p.info && p.info.id);
  if (!id) return;
  switch (ev.type) {
    case "session.execution.succeeded":
    case "session.execution.failed":
      return state(cwd, id, "Stop");
    case "session.created":
      return state(cwd, id, "SessionStart");
    case "session.idle":
      return state(cwd, id, "Stop");
    case "session.status":
      return p.status && p.status.type === "idle" ? state(cwd, id, "Stop") : undefined;
    case "permission.asked":
    case "permission.updated":
      return state(cwd, id, "Notification", {
        notification_type: "permission_prompt",
        message: String(p.title || p.permission || "Permission needed"),
      });
    case "session.deleted":
      return state(cwd, id, "SessionEnd");
  }
}

export default {
  id: "werkmeister",
  async setup(ctx) {
    const cwd = ctx.location.directory;
    await ctx.tool.hook("execute.before", (e) => before(cwd, e.sessionID, e.tool, e.input));
    await ctx.tool.hook("execute.after", (e) => state(cwd, e.sessionID, "PostToolUse", { tool_name: e.tool }));
    await ctx.session.hook("prompt", (e) => prompt(cwd, e.sessionID));
    const stop = new AbortController();
    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: stop.signal })) await onEvent(cwd, ev);
      } catch {}
    })();
    return () => stop.abort();
  },
  async server({ directory }) {
    return {
      "tool.execute.before": (input, output) => before(directory, input.sessionID, input.tool, output.args),
      "tool.execute.after": (input) => state(directory, input.sessionID, "PostToolUse", { tool_name: input.tool }),
      "chat.message": (input) => prompt(directory, input.sessionID),
      event: ({ event }) => onEvent(directory, event),
    };
  },
};
`;

/** AUTONOMOUS_DENY's shell rules in OpenCode's form: `Bash(werkmeister infra down:*)` → `werkmeister infra down*`. */
export const OPENCODE_BASH_DENY: Record<string, "deny"> = Object.fromEntries(
  AUTONOMOUS_DENY.flatMap((rule) => {
    const m = /^Bash\((.+):\*\)$/.exec(rule);
    return m ? [[`${m[1]}*`, "deny" as const]] : [];
  }),
);

/** Writes the plugin, and werkmeister's MCP server and shell denies into `opencode.json`; returns the plugin path. */
export function writeOpencodeHooks(workspaceRoot: string): string {
  const plugin = path.join(workspaceRoot, OPENCODE_PLUGIN_PATH);
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.writeFileSync(plugin, OPENCODE_PLUGIN);

  const configPath = path.join(workspaceRoot, "opencode.json");
  let config: Record<string, any> = { $schema: "https://opencode.ai/config.json" };
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    } catch {
      // The person's file: a JSONC comment or a typo must not cost them their config.
      warn(
        `opencode.json is not plain JSON; left it as is. Add the werkmeister MCP server by hand.`,
      );
      return plugin;
    }
  }
  config.mcp = {
    ...config.mcp,
    werkmeister: {
      type: "remote",
      // Loopback only, as for Codex: a file written inside a container must still work on the host.
      url: `http://127.0.0.1:${daemonPort()}/mcp`,
      // A tokenless loopback call acts as the whole machine; the token scopes it to this workspace.
      // OpenCode reads {file:} relative to this file, and a missing token file does not fail its config.
      headers: { Authorization: "Bearer {file:.werkmeister/token}" },
    },
  };
  // Always, not only on unattended turns: `run` talks to a background service, so a per-turn
  // config may never reach it. The MCP tools are scoped by the workspace token instead.
  const bash = config.permission?.bash;
  config.permission = {
    ...config.permission,
    // The person's rules first: OpenCode lets the last matching rule win, so the denies hold.
    bash: { ...(typeof bash === "string" ? { "*": bash } : bash), ...OPENCODE_BASH_DENY },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return plugin;
}
