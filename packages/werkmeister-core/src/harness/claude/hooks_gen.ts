/**
 * Generated workspace hooks — docs/jit-context-system.md §5.6, §6.
 *
 * Emits two managed hooks into each workspace's `.claude/settings.json` (`.codex/hooks.json` on
 * `harness: codex`, SW-189: gate matcher `apply_patch`, PermissionRequest for Notification):
 *
 * - SessionStart: every new context window (startup / resume / clear /
 *   post-compaction) runs `werkmeister notes context`, which injects the latest
 *   handoff + open decision notes as session context. One matcher-less hook
 *   covers both involuntary boundaries — fresh sessions AND the window rebirth
 *   after compaction (SessionStart's `compact` source).
 * - PreToolUse (matcher `Edit|Write`): every governed edit runs `werkmeister
 *   hooks gate`, which denies the first Edit/Write per session x domain once,
 *   carrying the loading instructions in the deny reason.
 * - PreToolUse (matcher `Bash|mcp__.*create_pull_request`): `werkmeister hooks
 *   pr-guard` denies opening a PR any way but `werkmeister pr open`
 *   (docs/workspace-lifecycle.md). Unlike the two above it is installed for
 *   every strategy (`writePrGuardHook`), and `removeWorkspaceHooks` keeps it.
 * - SessionEnd: `werkmeister internal session-end` stops the workspace's feature when the
 *   session ends and no other is open there (#231). Only while `auto_stop` is
 *   on (`writeAutoStopHook`, every strategy); turning it off removes the entry.
 * - SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop,
 *   SessionEnd: `werkmeister internal agent-state` records working / needs-you / done in
 *   `.werkmeister/agent-state.json` for the pane and dashboard (SW-46), and each
 *   session's busy / idle for idle-stop and the resume nudge (SW-182). Every
 *   strategy (`writeAgentStateHooks`); the event name arrives on stdin.
 *   While `paused.json` exists the same hook blocks every tool call and prompt
 *   (SW-70), so existing workspaces get the pause gate with no settings rewrite.
 *
 * - `permissions.allow`: the workspace's test commands and read-only git, for
 *   every strategy (`writeWorkspacePermissions`), so a headless session can run
 *   the stage's test step without an approval prompt. An `autonomous` workspace
 *   also gets `autonomousRules` — what a run needs to reach `werkmeister pr open`,
 *   scoped to its own feature — and `AUTONOMOUS_DENY` in `permissions.deny`.
 * - `model`: the workspace's `model` input (`writeWorkspaceModel`), so a session
 *   opened in the folder starts on it.
 *
 * Unlike the other projections, settings.json may legitimately hold user
 * entries (JSON carries no do-not-hand-edit comment), so this generator merges:
 * it owns exactly the hook entries whose command contains each marker below,
 * and the allow/deny rules and model recorded in `.werkmeister/claude-permissions.json`,
 * replacing stale versions and preserving everything else.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  candidateServiceNames,
  containerTestCommand,
  serviceTestCommand,
} from "../../archetypes.js";
import {
  type ArchetypeRegistry,
  dotDir,
  loadArchetypes,
  loadReposConfig,
  loadServices,
  type ServicesConfig,
} from "../../config.js";
import { info } from "../../reporter.js";
import { repoDirs } from "../../standards.js";
import { tempHomeWrapper } from "../../temp_home.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { readAutonomous, readAutoStop, readModel } from "../../workspace_prompts.js";
import { AUTONOMOUS_DENY, CLI_NAMES, cli, pluginTool } from "../autonomous_deny.js";
import { CODEX_HOOKS_FILE, CODEX_LAUNCH, writeCodexConfig } from "../codex/index.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { harnessLayoutFor } from "../layout.js";

export { AUTONOMOUS_DENY };

// Markers doubling as the payload: entries containing them are werkmeister-managed.
const _HOOK_MARKER = "werkmeister notes context";
const _GATE_MARKER = "werkmeister internal gate";
const _PR_GUARD_MARKER = "werkmeister internal pr-guard";
const _AUTO_STOP_MARKER = "werkmeister internal session-end";
const _AGENT_STATE_MARKER = "werkmeister internal agent-state";

// The same hooks as written before SW-186's renames, so the next write replaces them.
const _PRE_SW186_MARKERS: Record<string, string> = {
  [_GATE_MARKER]: "werkmeister hooks gate",
  [_PR_GUARD_MARKER]: "werkmeister hooks pr-guard",
  [_AUTO_STOP_MARKER]: "werkmeister stop --if-idle",
  [_AGENT_STATE_MARKER]: "werkmeister hooks agent-state",
};

// Projections lag whenever the standards tree moves on after a workspace was
// inited, and nothing else re-runs the writer — so the session that would read a
// stale skill is the one that repairs it. `check` first because it is read-only:
// a current workspace pays 0.4s and no rewritten files, and only a drifted one
// takes the `sync` branch. Both are silenced — SessionStart stdout is injected
// into the context window, and only `notes context` has earned that space.
const _SKILLS_SELF_HEAL =
  "werkmeister skills check >/dev/null 2>&1 || werkmeister skills sync >/dev/null 2>&1";

// `werkmeister` resolves via PATH; if this machine doesn't expose it (or the
// workspace is driven by a harness with a stripped env), the hook must no-op
// silently rather than surface a warning on every session start / edit.
// `_HOOK_MARKER` must survive any rewording of SessionStart's command: it is how
// `_isManaged` recognises the entry to replace, so losing it leaves every
// existing workspace with two SessionStart hooks instead of one updated one.
export const SESSION_START_COMMAND = `command -v werkmeister >/dev/null 2>&1 && { ${_SKILLS_SELF_HEAL}; ${_HOOK_MARKER}; } || true`;
export const PRE_TOOL_USE_GATE_COMMAND = `command -v werkmeister >/dev/null 2>&1 && ${_GATE_MARKER} || true`;
export const PR_GUARD_COMMAND = `command -v werkmeister >/dev/null 2>&1 && ${_PR_GUARD_MARKER} || true`;
export const SESSION_END_COMMAND = `command -v werkmeister >/dev/null 2>&1 && ${_AUTO_STOP_MARKER} >/dev/null 2>&1 || true`;
export const AGENT_STATE_COMMAND = `command -v werkmeister >/dev/null 2>&1 && ${_AGENT_STATE_MARKER} || true`;
// The pause gate needs the harness and agent_state cannot import harness/layout (cycle via jira), so the command says it.
export const CODEX_AGENT_STATE_COMMAND = `command -v werkmeister >/dev/null 2>&1 && WERKMEISTER_HOOK_HARNESS=codex ${_AGENT_STATE_MARKER} || true`;

/** The events agent_state.ts needs: working / needs-you / done, and session start and end. */
export const AGENT_STATE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

/** {@link AGENT_STATE_EVENTS} on Codex, which has no Notification: its approval prompts arrive as PermissionRequest. */
export const CODEX_AGENT_STATE_EVENTS = AGENT_STATE_EVENTS.map((e) =>
  e === "Notification" ? "PermissionRequest" : e,
);

// SessionEnd hooks get a 1.5s budget unless one sets `timeout`, and the CLI's own
// start-up can take most of that. The stop itself runs detached, so this only
// bounds the idle check.
const _SESSION_END_TIMEOUT_S = 10;
// Codex caps SessionEnd hooks at 3 s.
const _CODEX_SESSION_END_TIMEOUT_S = 3;

const isCodex = (workspaceRoot: string) => harnessLayoutFor(workspaceRoot).id === "codex";

/** One matcher group under `hooks.<event>` in `.claude/settings.json`. */
export type HookEntry = {
  matcher?: string;
  hooks: { type: "command"; command: string; timeout?: number }[];
};

/** The managed SessionStart matcher-group (matcher-less: all sources). */
export function buildSessionStartEntry(): HookEntry {
  return { hooks: [{ type: "command", command: SESSION_START_COMMAND }] };
}

/** The managed PreToolUse matcher-group (Edit/Write only). */
export function buildPreToolUseGateEntry(codex = false): HookEntry {
  return {
    // Codex edits files only through apply_patch.
    matcher: codex ? "apply_patch" : "Edit|Write",
    hooks: [{ type: "command", command: PRE_TOOL_USE_GATE_COMMAND }],
  };
}

/** The managed PR-guard matcher-group: shell `gh pr create` and the GitHub MCP's create tool. */
export function buildPrGuardEntry(): HookEntry {
  return {
    matcher: "Bash|mcp__.*create_pull_request",
    hooks: [{ type: "command", command: PR_GUARD_COMMAND }],
  };
}

/** The managed SessionEnd matcher-group (matcher-less: every exit reason; the command filters). */
export function buildSessionEndEntry(codex = false): HookEntry {
  const timeout = codex ? _CODEX_SESSION_END_TIMEOUT_S : _SESSION_END_TIMEOUT_S;
  return { hooks: [{ type: "command", command: SESSION_END_COMMAND, timeout }] };
}

/** The managed agent-state matcher-group, the same for every event in {@link AGENT_STATE_EVENTS}. */
export function buildAgentStateEntry(codex = false): HookEntry {
  return {
    hooks: [{ type: "command", command: codex ? CODEX_AGENT_STATE_COMMAND : AGENT_STATE_COMMAND }],
  };
}

// A pre-SW-106 entry ran `sandbox …`: recognising it lets the next write replace it, not add a twin. // name-check: ignore
const isManagedCommand = (command: string, marker: string) =>
  [marker, _PRE_SW186_MARKERS[marker]].some(
    (m) =>
      m !== undefined &&
      (command.includes(m) || command.includes(m.replace(/^werkmeister /, "sandbox "))), // name-check: ignore
  );

function _isManaged(entry: unknown, marker: string = _HOOK_MARKER): boolean {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const inner = (entry as Record<string, unknown>)["hooks"];
  if (!Array.isArray(inner)) {
    return false;
  }
  return inner.some(
    (hook) =>
      typeof hook === "object" &&
      hook !== null &&
      !Array.isArray(hook) &&
      isManagedCommand(String((hook as Record<string, unknown>)["command"] ?? ""), marker),
  );
}

/**
 * Replace *event*'s managed entry (by *marker*) in *hooks*, preserving
 * everything else. Returns false (no-op) on a structurally-unexpected existing
 * value for *event* — a human put something there.
 */
function _mergeEvent(
  hooks: Record<string, unknown>,
  event: string,
  managedEntry: HookEntry,
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

type Managed = [event: string, entry: HookEntry, marker: string];

function _isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _settingsPath(workspaceRoot: string): string {
  return isCodex(workspaceRoot)
    ? path.join(workspaceRoot, CODEX_HOOKS_FILE)
    : path.join(workspaceRoot, ".claude", "settings.json");
}

/** The settings object (`{}` when absent), or null when a human left something we must not rewrite. */
function _readSettings(settingsPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return _isDict(existing) ? existing : null;
  } catch {
    return null;
  }
}

/** Write *settings*, or remove the file (and `.claude/` if that empties it) once nothing is left. */
function _saveSettings(settingsPath: string, settings: Record<string, unknown>): void {
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
 * entries within each managed event; replaces any stale werkmeister-managed entry.
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
  const hooks = settings["hooks"] as Record<string, unknown> | null;
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
    ["PreToolUse", buildPreToolUseGateEntry(isCodex(workspaceRoot)), _GATE_MARKER],
    ["PreToolUse", buildPrGuardEntry(), _PR_GUARD_MARKER],
  ]);
}

/** The agent-state hook on each of its events. */
export function writeAgentStateHooks(workspaceRoot: string): string {
  const codex = isCodex(workspaceRoot);
  return _writeManaged(
    workspaceRoot,
    (codex ? CODEX_AGENT_STATE_EVENTS : AGENT_STATE_EVENTS).map((event) => [
      event,
      buildAgentStateEntry(codex),
      _AGENT_STATE_MARKER,
    ]),
  );
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
  return _removeManaged(workspaceRoot, [
    ["SessionStart", _HOOK_MARKER],
    ["PreToolUse", _GATE_MARKER],
  ]);
}

/** The SessionEnd auto-stop entry while *on*; otherwise remove it, keeping hand-added ones. */
export function writeAutoStopHook(workspaceRoot: string, on: boolean): string {
  if (on) {
    return _writeManaged(workspaceRoot, [
      ["SessionEnd", buildSessionEndEntry(isCodex(workspaceRoot)), _AUTO_STOP_MARKER],
    ]);
  }
  _removeManaged(workspaceRoot, [["SessionEnd", _AUTO_STOP_MARKER]]);
  return _settingsPath(workspaceRoot);
}

function _removeManaged(
  workspaceRoot: string,
  managed: ReadonlyArray<readonly [event: string, marker: string]>,
): string[] {
  const settingsPath = _settingsPath(workspaceRoot);
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    return [];
  }
  const hooks = settings?.["hooks"] as Record<string, unknown> | null | undefined;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return [];
  }
  const removed: string[] = [];
  for (const [event, marker] of managed) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((entry) => !_isManaged(entry, marker));
    for (const entry of entries) {
      if (!kept.includes(entry))
        removed.push(
          ...entry["hooks"].map((h: HookEntry["hooks"][number]) => String(h["command"])),
        );
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

export const READ_ONLY_GIT_RULES = [
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git ls-files:*)",
];

// `claude -p --permission-mode acceptEdits` (claude-send) refuses any Bash call
// without a rule and nobody is there to approve it (#175). These cover the run
// from stage 01 to `werkmeister pr open` and stop at its own workspace: no
// `werkmeister:*`, `docker:*`, `npm:*`, `gh:*` or whole MCP server, which reached
// the shared proxy, other features and the linked CLI. The PR guard is a
// PreToolUse deny, so `gh pr create` stays blocked.
export const AUTONOMOUS_RULES = [
  "Bash(git:*)",
  // `werkmeister pr open` does the push and the PR; gh is read-only here.
  ...["pr view", "pr checks", "pr diff", "pr list", "issue view", "run view", "run list"].map(
    (cmd) => `Bash(gh ${cmd}:*)`,
  ),
  // No-arg forms act on the cwd's FEATURE; `autonomousRules` adds the named ones.
  // Each pre-SW-186 spelling keeps its rule until the CLI drops it, beside its new one.
  ...["up", "restart", "feature up", "feature restart"].flatMap(cli),
  // SW-132: one of its own services, on-demand ones included, the way the PR gate starts them.
  ...cli("feature up --service:*"),
  ...[
    "status",
    "feature status",
    "infra status",
    "pr",
    "issue view",
    "issue start",
    "init-workspace",
    "workspace init",
    "skills",
    "standards",
    "notes context",
  ].flatMap((cmd) => cli(`${cmd}:*`)),
  "Bash(docker ps:*)",
  // Local build and test; no `npm install` or `pnpm add`, so a new dependency waits for a person.
  ...["npm ci", "npm run", "npm test", "npx", "node", "python3"].map((cmd) => `Bash(${cmd}:*)`),
  ...["install --frozen-lockfile", "run", "test", "exec", "turbo"].map(
    (cmd) => `Bash(pnpm ${cmd}:*)`,
  ),
  ...["ls", "cat", "grep", "find", "head", "tail", "sed", "diff", "wc", "test", "mkdir"].map(
    (cmd) => `Bash(${cmd}:*)`,
  ),
  // A plugin's pane tests; never `claude plugin:*`, which would also allow install/uninstall.
  "Bash(claude plugin validate:*)",
  "Bash(claude plugin test:*)",
  // Read-only tools; the rest take any workspace's name.
  ...[
    "issue",
    "issue-statuses",
    "status",
    "workspace-prs",
    "kube-context",
    "k8s-forwards-status",
  ].flatMap(pluginTool),
];

/** AUTONOMOUS_RULES plus the `werkmeister` and `docker` commands that name this feature or its containers. */
export function autonomousRules(feature: string, services: string[]): string[] {
  if (!feature) return AUTONOMOUS_RULES;
  return [
    ...AUTONOMOUS_RULES,
    // Exact: `werkmeister feature restart <f> infra` and `docker restart <f>-a <other>` stay out.
    ...["up", "restart", "feature up", "feature restart"].flatMap((cmd) =>
      cli(`${cmd} ${feature}`),
    ),
    ...cli(`feature up ${feature} --service:*`),
    ...["logs", "test", "services", "feature logs", "feature test", "feature services"].flatMap(
      (cmd) => cli(`${cmd} ${feature}:*`),
    ),
    ...services.flatMap((svc) => [
      `Bash(docker exec ${feature}-${svc}:*)`,
      `Bash(docker logs ${feature}-${svc}:*)`,
      `Bash(docker restart ${feature}-${svc})`,
    ]),
  ];
}

// Permission strings can't carry a marker the way hook commands do, so the rules
// werkmeister inserted are listed here; anything else in `allow`/`deny` is the person's.
const permissionsRecord = (workspaceRoot: string) =>
  path.join(dotDir(workspaceRoot), "claude-permissions.json");

/**
 * Allow rules for each local service's registered test command, then read-only
 * git. Each command gets the container form the agent is told to run, plus the
 * bare command as a prefix, plus the bare command through *tempHome* (the
 * form werkmeister-context.md states; never the wrapper alone, which runs anything).
 * A service with no command gets none. Each of *builtClis* (SW-172) also gets
 * the wrapped form: the temp HOME is what makes running it safe to pre-approve.
 */
export function buildAllowRules(
  feature: string,
  services: string[],
  servicesConfig: ServicesConfig,
  archetypes: ArchetypeRegistry,
  tempHome = "",
  builtClis: string[] = [],
  // Services whose tests run on the host only (no container): wrapped rules, no container form.
  hostServices: string[] = [],
): string[] {
  const rules: string[] = [];
  // SW-398: a Claude rule matches each `&&` segment on its own, so a chained test command
  // needs one rule per segment; the first is the one the context file runs through tempHome.
  const segments = (cmd: string) => cmd.split(/\s*&&\s*/).filter(Boolean);
  for (const svc of [...services, ...hostServices]) {
    const cmd = serviceTestCommand(svc, servicesConfig[svc], archetypes);
    if (!cmd) continue;
    const [first = cmd, ...rest] = segments(cmd);
    if (services.includes(svc)) {
      rules.push(`Bash(${containerTestCommand(feature, svc, cmd)})`);
      rules.push(...segments(cmd).map((c) => `Bash(${c}:*)`));
    }
    if (tempHome) rules.push(`Bash(${tempHome} ${first}:*)`);
    if (tempHome) rules.push(...rest.map((c) => `Bash(${c}:*)`));
  }
  if (tempHome) for (const cli of builtClis) rules.push(`Bash(${tempHome} ${cli}:*)`);
  // SW-292: its sibling runs only the workspace's own built CLI, in a fixture, so it is safe whole;
  // its --exec-runs form, which runs the registry's rows on the host, asks first (workspaceAskRules).
  if (tempHome && builtClis.length)
    rules.push(`Bash(${path.join(path.dirname(tempHome), "with-fixture-workspace")}:*)`);
  // Never `Bash(${tempHome}:*)` nor its `node --test` form: both run any file (SW-510, workspaceAskRules).
  // SW-367: each wrapped form again with the wrapper's --no-wait flag first.
  const wrapped = `Bash(${tempHome} `;
  if (tempHome)
    rules.push(
      ...rules
        .filter((r) => r.startsWith(wrapped))
        .map((r) => `${wrapped}--no-wait ${r.slice(wrapped.length)}`),
    );
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
 * its `autonomous` input; a `pr watch` wake passes `autonomous: true` (SW-313).
 * Reads `.env` itself: lifecycle.ts's reader would close an import cycle
 * (lifecycle → strategies → jit → here).
 */
export function workspaceAllowRules(
  workspaceRoot: string,
  autonomous = readAutonomous(workspaceRoot),
): string[] {
  const env = _readEnv(workspaceRoot);
  const feature = env["FEATURE"] ?? "";
  const services = (env["SERVICES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const wrapper = tempHomeWrapper(workspaceRoot);
  const builtClis = builtCliWrappers(workspaceRoot);
  // SW-398: the context file lists every service of the workspace's repos, so their test commands are allowed too.
  const repoNames = repoDirs(workspaceRoot).map((d) => path.basename(d));
  let hostServices: string[] = [];
  try {
    // loadReposConfig warns when the machine has no registry; a workspace without repos never needs it.
    if (repoNames.length) hostServices = candidateServiceNames(repoNames, loadReposConfig());
  } catch {
    // No machine registry (services.yaml): only the selected services get rules.
  }
  const extra = hostServices.filter((s) => !services.includes(s));
  const any = services.length > 0 || extra.length > 0;
  const rules = buildAllowRules(
    any ? feature : "",
    services,
    any ? loadServices() : {},
    any ? loadArchetypes() : {},
    wrapper,
    builtClis,
    extra,
  );
  return autonomous ? [...new Set([...rules, ...autonomousRules(feature, services)])] : rules;
}

function builtCliWrappers(workspaceRoot: string): string[] {
  return repoDirs(workspaceRoot)
    .map((d) => path.join(d, "apps", "cli", "werkmeister"))
    .filter((f) => fs.existsSync(f));
}

/**
 * SW-473: `--exec-runs` runs the registry's rows on the host, so its forms of the pre-approved fixture
 * wrapper and built CLI ask first. The CLI takes it only as the first fixture option, so a prefix catches it.
 * SW-510: `node --test <file>` through the temp-HOME wrapper runs any file, one the agent just wrote too.
 */
export function workspaceAskRules(workspaceRoot: string): string[] {
  const tempHome = tempHomeWrapper(workspaceRoot);
  const nodeTest = [
    `Bash(${tempHome} env WERKMEISTER_ROOT=* node --test:*)`,
    `Bash(${tempHome} --no-wait env WERKMEISTER_ROOT=* node --test:*)`,
  ];
  const builtClis = builtCliWrappers(workspaceRoot);
  if (!builtClis.length) return nodeTest;
  const fixture = path.join(path.dirname(tempHome), "with-fixture-workspace");
  return [
    `Bash(${fixture} --exec-runs:*)`,
    `Bash(${fixture} --no-wait --exec-runs:*)`,
    ...builtClis.flatMap((cli) => [
      `Bash(${tempHome} ${cli} internal fixture --exec-runs:*)`,
      `Bash(${tempHome} --no-wait ${cli} internal fixture --exec-runs:*)`,
    ]),
    ...nodeTest,
  ];
}

/** The deny rules this workspace should have: AUTONOMOUS_DENY while `autonomous` is on. */
export function workspaceDenyRules(
  workspaceRoot: string,
  autonomous = readAutonomous(workspaceRoot),
): string[] {
  return autonomous ? AUTONOMOUS_DENY : [];
}

interface PermissionsRecord {
  allow: string[];
  deny: string[];
  ask: string[];
  model: string | null;
}

const _strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((r): r is string => typeof r === "string") : [];

function _readRecord(recordPath: string): PermissionsRecord {
  try {
    const data = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (!_isDict(data)) return { allow: [], deny: [], ask: [], model: null };
    return {
      allow: _strings(data.allow),
      deny: _strings(data.deny),
      ask: _strings(data.ask),
      model: typeof data.model === "string" ? data.model : null,
    };
  } catch {
    return { allow: [], deny: [], ask: [], model: null };
  }
}

/** Write *record* if it changed, dropping empty keys; remove the file once all are empty. */
function _writeRecord(recordPath: string, record: PermissionsRecord): void {
  const body = {
    ...(record.allow.length ? { allow: record.allow } : {}),
    ...(record.deny.length ? { deny: record.deny } : {}),
    ...(record.ask.length ? { ask: record.ask } : {}),
    ...(record.model ? { model: record.model } : {}),
  };
  const previous = _readRecord(recordPath);
  if (JSON.stringify(record) === JSON.stringify(previous)) return;
  if (Object.keys(body).length) {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(recordPath, `${JSON.stringify(body, null, 2)}\n`);
  } else {
    fs.rmSync(recordPath, { force: true });
  }
}

/**
 * Merge *allow* and *deny* into `.claude/settings.json` `permissions`.
 *
 * Adds what is missing, drops rules werkmeister added earlier that are no longer
 * wanted, and never touches a rule it didn't add — one the person already had
 * is not recorded, so it survives removal. Unparseable JSON or an unexpected
 * `permissions` / `allow` / `deny` shape is left untouched, record included.
 */
export function writeWorkspacePermissions(
  workspaceRoot: string,
  allow: string[],
  deny: string[] = [],
  ask: string[] = [],
): string {
  const settingsPath = _settingsPath(workspaceRoot);
  const settings = _readSettings(settingsPath);
  if (settings === null) return settingsPath;
  const permissions = settings["permissions"] ?? {};
  if (!_isDict(permissions)) return settingsPath;
  const lists = { allow, deny, ask };
  const keys = ["allow", "deny", "ask"] as const;
  if (keys.some((k) => !Array.isArray(permissions[k] ?? []))) return settingsPath;

  const recordPath = permissionsRecord(workspaceRoot);
  const stored = _readRecord(recordPath);
  const record = { ...stored };
  let changed = false;
  for (const key of keys) {
    const have = (permissions[key] as unknown[] | undefined) ?? [];
    const recorded = new Set(stored[key]);
    const wanted = [...new Set(lists[key])];
    const kept = have.filter(
      (rule) => !(typeof rule === "string" && recorded.has(rule) && !wanted.includes(rule)),
    );
    const added = wanted.filter((rule) => !kept.includes(rule));
    record[key] = wanted.filter((rule) => recorded.has(rule) || added.includes(rule));
    if (kept.length === have.length && !added.length) continue;
    changed = true;
    const next = [...kept, ...added];
    if (next.length) permissions[key] = next;
    else delete permissions[key];
  }

  if (changed) {
    if (Object.keys(permissions).length) settings["permissions"] = permissions;
    else delete settings["permissions"];
    _saveSettings(settingsPath, settings);
  }
  _writeRecord(recordPath, record);
  return settingsPath;
}

/** Remove every allow, deny and ask rule werkmeister added, keeping the person's. */
export function removeWorkspacePermissions(workspaceRoot: string): string {
  return writeWorkspacePermissions(workspaceRoot, [], [], []);
}

/**
 * Set `.claude/settings.json` `model` to *model*, or remove it when null.
 *
 * Only a model werkmeister recorded writing is replaced or removed: one the person
 * set (any value that differs from the record) is left as is and not recorded.
 * Unparseable JSON is left untouched, record included.
 */
export function writeWorkspaceModel(workspaceRoot: string, model: string | null): string {
  const settingsPath = _settingsPath(workspaceRoot);
  const settings = _readSettings(settingsPath);
  if (settings === null) return settingsPath;
  const recordPath = permissionsRecord(workspaceRoot);
  const stored = _readRecord(recordPath);
  const current = settings.model;

  if (current !== undefined && current !== stored.model) {
    _writeRecord(recordPath, { ...stored, model: null });
    return settingsPath;
  }
  if (current !== (model ?? undefined)) {
    if (model) settings.model = model;
    else delete settings.model;
    _saveSettings(settingsPath, settings);
  }
  _writeRecord(recordPath, { ...stored, model });
  return settingsPath;
}

/** The workspace's allow and deny rules, model, auto-stop and agent-state hooks, from its `.env`, registry and workspace.yml. */
export function writeWorkspaceSettings(workspaceRoot: string): void {
  if (isCodex(workspaceRoot)) {
    // permissions and model are Claude settings; Codex gets its MCP server instead.
    writeAutoStopHook(workspaceRoot, readAutoStop(workspaceRoot));
    writeAgentStateHooks(workspaceRoot);
    writeCodexConfig(workspaceRoot);
    info(
      `codex: trust this folder in Codex, approve its hooks with /hooks, and start it as \`${CODEX_LAUNCH}\` (docs/harnesses.md § Codex)`,
    );
    return;
  }
  writeWorkspacePermissions(
    workspaceRoot,
    workspaceAllowRules(workspaceRoot),
    workspaceDenyRules(workspaceRoot),
    workspaceAskRules(workspaceRoot),
  );
  writeWorkspaceModel(workspaceRoot, readModel(workspaceRoot));
  writeAutoStopHook(workspaceRoot, readAutoStop(workspaceRoot));
  writeAgentStateHooks(workspaceRoot);
}
