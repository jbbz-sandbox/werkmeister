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
 *
 * Unlike the other projections, settings.json may legitimately hold user
 * entries (JSON carries no do-not-hand-edit comment), so this generator merges:
 * it owns exactly the hook entries whose command contains each marker below,
 * replacing stale versions and preserving everything else.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// Markers doubling as the payload: entries containing them are sandbox-managed.
const _HOOK_MARKER = "sandbox notes context";
const _GATE_MARKER = "sandbox hooks gate";

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

/**
 * Merge the managed SessionStart + PreToolUse hooks into
 * `.claude/settings.json`.
 *
 * Preserves user-added settings keys, other hook events, and non-managed
 * entries within each managed event; replaces any stale sandbox-managed entry.
 * Unparseable existing JSON, structurally-unexpected `hooks` or per-event
 * shapes, and non-dict entries within an event are left untouched (returning
 * the path) rather than clobbered — a human put something there.
 */
export function writeWorkspaceHooks(workspaceRoot: string): string {
  const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath) && fs.statSync(settingsPath).isFile()) {
    try {
      const existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
        settings = existing;
      } else {
        return settingsPath;
      }
    } catch {
      return settingsPath;
    }
  }

  if (!("hooks" in settings)) {
    settings["hooks"] = {};
  }
  const hooks = settings["hooks"];
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) {
    return settingsPath;
  }
  if (!_mergeEvent(hooks, "SessionStart", buildSessionStartEntry(), _HOOK_MARKER)) {
    return settingsPath;
  }
  if (!_mergeEvent(hooks, "PreToolUse", buildPreToolUseGateEntry(), _GATE_MARKER)) {
    return settingsPath;
  }

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return settingsPath;
}

/**
 * Remove every sandbox-managed hook entry from `.claude/settings.json`,
 * keeping hand-added ones. When nothing else is left, the file goes too, and
 * `.claude/` if that empties it. Returns the removed commands. Unparseable
 * JSON or an unexpected shape is left untouched — the writer's doctrine.
 */
export function removeWorkspaceHooks(workspaceRoot: string): string[] {
  const settingsPath = path.join(workspaceRoot, ".claude", "settings.json");
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
  if (Object.keys(settings).length) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  } else {
    fs.rmSync(settingsPath);
    try {
      fs.rmdirSync(path.dirname(settingsPath));
    } catch {
      // .claude/ holds something else — keep it
    }
  }
  return removed;
}
