/**
 * Generated workspace hooks — docs/jit-context-system.md §5.6, §6.
 *
 * Emits two managed hooks into each workspace's `.claude/settings.json`:
 *
 * - SessionStart: every new context window (startup / resume / clear /
 *   post-compaction) runs `sandbox notes context`, which injects the latest
 *   handoff + open decision notes as session context. One matcher-less hook
 *   covers both involuntary boundaries — fresh sessions AND the window rebirth
 *   after compaction (SessionStart's `compact` source).
 * - PreToolUse (matcher `Edit|Write`): every governed edit runs `sandbox
 *   hooks gate`, which denies the first Edit/Write per session x domain once,
 *   carrying the loading instructions in the deny reason.
 * - PreToolUse (matcher `Bash|mcp__.*create_pull_request`): `sandbox hooks
 *   pr-guard` denies opening a PR any way but `sandbox pr open`
 *   (docs/workspace-lifecycle.md). Unlike the two above it is installed for
 *   every strategy (`writePrGuardHook`), and `removeWorkspaceHooks` keeps it.
 *
 * - `permissions.allow`: the workspace's test commands and read-only git, for
 *   every strategy (`writeWorkspacePermissions`), so a headless session can run
 *   the stage's test step without an approval prompt. An `autonomous` workspace
 *   also gets `AUTONOMOUS_RULES` — everything a run needs to reach `sandbox pr open`.
 *
 * Unlike the other projections, settings.json may legitimately hold user
 * entries (JSON carries no do-not-hand-edit comment), so this generator merges:
 * it owns exactly the hook entries whose command contains each marker below,
 * and the allow rules recorded in `.sandbox/claude-permissions.json`,
 * replacing stale versions and preserving everything else.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { containerTestCommand, serviceTestCommand } from "./archetypes.js";
import { loadArchetypes, loadServices } from "./config.js";
import { readAutonomous } from "./workspace_prompts.js";

// Markers doubling as the payload: entries containing them are sandbox-managed.
const _HOOK_MARKER = "sandbox notes context";
const _GATE_MARKER = "sandbox hooks gate";
const _PR_GUARD_MARKER = "sandbox hooks pr-guard";

// Projections lag whenever the standards tree moves on after a workspace was
// inited, and nothing else re-runs the writer — so the session that would read a
// stale skill is the one that repairs it. `check` first because it is read-only:
// a current workspace pays 0.4s and no rewritten files, and only a drifted one
// takes the `sync` branch. Both are silenced — SessionStart stdout is injected
// into the context window, and only `notes context` has earned that space.
const _SKILLS_SELF_HEAL =
  "sandbox skills check >/dev/null 2>&1 || sandbox skills sync >/dev/null 2>&1";

// `sandbox` resolves via PATH; if this machine doesn't expose it (or the
// workspace is driven by a harness with a stripped env), the hook must no-op
// silently rather than surface a warning on every session start / edit.
// `_HOOK_MARKER` must survive any rewording of SessionStart's command: it is how
// `_isManaged` recognises the entry to replace, so losing it leaves every
// existing workspace with two SessionStart hooks instead of one updated one.
export const SESSION_START_COMMAND = `command -v sandbox >/dev/null 2>&1 && { ${_SKILLS_SELF_HEAL}; ${_HOOK_MARKER}; } || true`;
export const PRE_TOOL_USE_GATE_COMMAND = `command -v sandbox >/dev/null 2>&1 && ${_GATE_MARKER} || true`;
export const PR_GUARD_COMMAND = `command -v sandbox >/dev/null 2>&1 && ${_PR_GUARD_MARKER} || true`;

/** The managed SessionStart matcher-group (matcher-less: all sources). */
export function buildSessionStartEntry(): Record<string, any> {
  return { hooks: [{ type: "command", command: SESSION_START_COMMAND }] };
}

/** The managed PreToolUse matcher-group (Edit/Write only). */
export function buildPreToolUseGateEntry(): Record<string, any> {
  return {
    matcher: "Edit|Write",
    hooks: [{ type: "command", command: PRE_TOOL_USE_GATE_COMMAND }],
  };
}

/** The managed PR-guard matcher-group: shell `gh pr create` and the GitHub MCP's create tool. */
export function buildPrGuardEntry(): Record<string, any> {
  return {
    matcher: "Bash|mcp__.*create_pull_request",
    hooks: [{ type: "command", command: PR_GUARD_COMMAND }],
  };
}

function _isManaged(entry: unknown, marker: string = _HOOK_MARKER): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const inner = (entry as Record<string, any>)["hooks"];
  if (!Array.isArray(inner)) {
    return false;
  }
  return inner.some(
    (hook) =>
      typeof hook === "object" &&
      hook !== null &&
      !Array.isArray(hook) &&
      String((hook as Record<string, any>)["command"] ?? "").includes(marker),
  );
}

/**
 * Replace *event*'s managed entry (by *marker*) in *hooks*, preserving
 * everything else. Returns false (no-op) on a structurally-unexpected existing
 * value for *event* — a human put something there.
 */
function _mergeEvent(
  hooks: Record<string, any>,
  event: string,
  managedEntry: Record<string, any>,
  marker: string,
): boolean {
  const existing = event in hooks ? hooks[event] : [];
  if (!Array.isArray(existing)) {
    return false;
  }
  const kept = existing.filter((entry) => !_isManaged(entry, marker));
  kept.push(managedEntry);
  hooks[event] = kept;
  return true;
}

type Managed = [event: string, entry: Record<string, any>, marker: string];

function _isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _settingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".claude", "settings.json");
}

/** The settings object (`{}` when absent), or null when a human left something we must not rewrite. */
function _readSettings(settingsPath: string): Record<string, any> | null {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return _isDict(existing) ? existing : null;
  } catch {
    return null;
  }
}

/** Write *settings*, or remove the file (and `.claude/` if that empties it) once nothing is left. */
function _saveSettings(settingsPath: string, settings: Record<string, any>): void {
  if (Object.keys(settings).length) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    return;
  }
  fs.rmSync(settingsPath, { force: true });
  try {
    fs.rmdirSync(path.dirname(settingsPath));
  } catch {
    // .claude/ holds something else — keep it
  }
}

/**
 * Merge *managed* entries into `.claude/settings.json`.
 *
 * Preserves user-added settings keys, other hook events, and non-managed
 * entries within each managed event; replaces any stale sandbox-managed entry.
 * Unparseable existing JSON, structurally-unexpected `hooks` or per-event
 * shapes, and non-dict entries within an event are left untouched (returning
 * the path) rather than clobbered — a human put something there.
 */
function _writeManaged(workspaceRoot: string, managed: Managed[]): string {
  const settingsPath = _settingsPath(workspaceRoot);
  const settings = _readSettings(settingsPath);
  if (settings === null) {
    return settingsPath;
  }

  if (!("hooks" in settings)) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return settingsPath;
  }
  for (const [event, entry, marker] of managed) {
    if (!_mergeEvent(hooks, event, entry, marker)) {
      return settingsPath;
    }
  }

  _saveSettings(settingsPath, settings);
  return settingsPath;
}

/** The JIT hooks (SessionStart + standards gate) plus the PR guard. */
export function writeWorkspaceHooks(workspaceRoot: string): string {
  return _writeManaged(workspaceRoot, [
    ["SessionStart", buildSessionStartEntry(), _HOOK_MARKER],
    ["PreToolUse", buildPreToolUseGateEntry(), _GATE_MARKER],
    ["PreToolUse", buildPrGuardEntry(), _PR_GUARD_MARKER],
  ]);
}

/** The PR guard alone — what a non-JIT workspace gets. */
export function writePrGuardHook(workspaceRoot: string): string {
  return _writeManaged(workspaceRoot, [["PreToolUse", buildPrGuardEntry(), _PR_GUARD_MARKER]]);
}

/**
 * Remove the JIT-managed hook entries from `.claude/settings.json`, keeping
 * hand-added ones and the PR guard. When nothing else is left, the file goes too, and
 * `.claude/` if that empties it. Returns the removed commands. Unparseable
 * JSON or an unexpected shape is left untouched — the writer's doctrine.
 */
export function removeWorkspaceHooks(workspaceRoot: string): string[] {
  const settingsPath = _settingsPath(workspaceRoot);
  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = settings?.["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return [];
  }
  const removed: string[] = [];
  for (const [event, marker] of [
    ["SessionStart", _HOOK_MARKER],
    ["PreToolUse", _GATE_MARKER],
  ] as const) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !_isManaged(entry, marker));
    for (const entry of entries) {
      if (!kept.includes(entry)) removed.push(...entry["hooks"].map((h: any) => String(h["command"])));
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed.length) {
    return [];
  }
  if (!Object.keys(hooks).length) delete settings["hooks"];
  _saveSettings(settingsPath, settings);
  return removed;
}

// ---------------------------------------------------------------------------
// permissions.allow — every strategy
// ---------------------------------------------------------------------------

export const READ_ONLY_GIT_RULES = ["Bash(git diff:*)", "Bash(git status:*)", "Bash(git ls-files:*)"];

// `claude -p --permission-mode acceptEdits` (claude-send) refuses any Bash call
// without a rule and nobody is there to approve it (#175). The PR guard is a
// PreToolUse deny, which outranks `Bash(gh:*)`, so `gh pr create` stays blocked.
export const AUTONOMOUS_RULES = [
  ...["git", "sandbox", "docker", "gh", "node", "npm", "npx", "python3"].map((cmd) => `Bash(${cmd}:*)`),
  ...["ls", "cat", "grep", "find", "head", "tail", "sed", "diff", "wc", "test", "mkdir"].map((cmd) => `Bash(${cmd}:*)`),
  // A plugin's pane tests; never `claude plugin:*`, which would also allow install/uninstall.
  "Bash(claude plugin validate:*)",
  "Bash(claude plugin test:*)",
  "mcp__plugin_sandbox-tools_sandbox-workspace",
];

// Permission strings can't carry a marker the way hook commands do, so the rules
// sandbox inserted are listed here; anything else in `allow` is the person's.
const _PERMISSIONS_RECORD = path.join(".sandbox", "claude-permissions.json");

/**
 * Allow rules for each local service's registered test command, then read-only
 * git. Each command gets the container form the agent is told to run, plus the
 * bare command as a prefix. A service with no command gets none.
 */
export function buildAllowRules(
  feature: string,
  services: string[],
  servicesConfig: Record<string, any>,
  archetypes: Record<string, any>,
): string[] {
  const rules: string[] = [];
  for (const svc of services) {
    const cmd = serviceTestCommand(svc, servicesConfig[svc], archetypes);
    if (cmd) rules.push(`Bash(${containerTestCommand(feature, svc, cmd)})`, `Bash(${cmd}:*)`);
  }
  return [...new Set([...rules, ...READ_ONLY_GIT_RULES])];
}

function _readEnv(workspaceRoot: string): Record<string, string> {
  let text: string;
  try {
    text = fs.readFileSync(path.join(workspaceRoot, ".env"), "utf8");
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return env;
}

/**
 * The allow rules this workspace should have, from its `.env`, the registry and
 * its `autonomous` input.
 * Reads `.env` itself: lifecycle.ts's reader would close an import cycle
 * (lifecycle → strategies → jit → here).
 */
export function workspaceAllowRules(workspaceRoot: string): string[] {
  const env = _readEnv(workspaceRoot);
  const feature = env["FEATURE"] ?? "";
  const services = (env["SERVICES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rules =
    feature && services.length ? buildAllowRules(feature, services, loadServices(), loadArchetypes()) : [...READ_ONLY_GIT_RULES];
  return readAutonomous(workspaceRoot) ? [...new Set([...rules, ...AUTONOMOUS_RULES])] : rules;
}

function _readRecord(recordPath: string): string[] {
  try {
    const data = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    return _isDict(data) && Array.isArray(data["allow"]) ? data["allow"].filter((r: unknown) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Merge *want* into `.claude/settings.json` `permissions.allow`.
 *
 * Adds what is missing, drops rules sandbox added earlier that are no longer
 * wanted, and never touches a rule it didn't add — one the person already had
 * is not recorded, so it survives removal. Unparseable JSON or an unexpected
 * `permissions` / `allow` shape is left untouched, record included.
 */
export function writeWorkspacePermissions(workspaceRoot: string, want: string[]): string {
  const settingsPath = _settingsPath(workspaceRoot);
  const settings = _readSettings(settingsPath);
  if (settings === null) return settingsPath;
  const permissions = settings["permissions"] ?? {};
  if (!_isDict(permissions)) return settingsPath;
  const allow: unknown[] = permissions["allow"] ?? [];
  if (!Array.isArray(allow)) return settingsPath;

  const recordPath = path.join(workspaceRoot, _PERMISSIONS_RECORD);
  const previous = _readRecord(recordPath);
  const recorded = new Set(previous);
  const wanted = [...new Set(want)];
  const kept = allow.filter((rule) => !(typeof rule === "string" && recorded.has(rule) && !wanted.includes(rule)));
  const added = wanted.filter((rule) => !kept.includes(rule));
  const record = wanted.filter((rule) => recorded.has(rule) || added.includes(rule));

  if (kept.length !== allow.length || added.length) {
    const next = [...kept, ...added];
    if (next.length) permissions["allow"] = next;
    else delete permissions["allow"];
    if (Object.keys(permissions).length) settings["permissions"] = permissions;
    else delete settings["permissions"];
    _saveSettings(settingsPath, settings);
  }
  if (JSON.stringify(record) !== JSON.stringify(previous)) {
    if (record.length) {
      fs.mkdirSync(path.dirname(recordPath), { recursive: true });
      fs.writeFileSync(recordPath, JSON.stringify({ allow: record }, null, 2) + "\n");
    } else {
      fs.rmSync(recordPath, { force: true });
    }
  }
  return settingsPath;
}

/** Remove every allow rule sandbox added, keeping the person's. */
export function removeWorkspacePermissions(workspaceRoot: string): string {
  return writeWorkspacePermissions(workspaceRoot, []);
}
