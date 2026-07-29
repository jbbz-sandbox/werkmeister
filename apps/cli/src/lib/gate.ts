/**
 * PreToolUse standards gate — docs/jit-context-system.md §6.
 *
 * Denies the first governed `Edit`/`Write` per session x domain, carrying the
 * loading instructions in the deny reason, then allows everything after
 * (fail-open, deny-once-with-payload — §2).
 *
 * Deliberately dependency-light (node builtins only — no commander/yaml/nunjucks,
 * nothing that touches the config/YAML chain): Phase 0 measured the normal
 * `sandbox` entrypoint at 250-460ms cold, well past this design's <200ms budget
 * for a hook that fires on every Edit/Write. The hook config runs
 * `node dist/lib/gate.js` on this file directly, bypassing the argparse-heavy
 * main import chain entirely. The normal `sandbox hooks gate` CLI path (manual
 * runs, tests) imports this same module — one implementation either way.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ponytail: duplicated (not imported) from notes.ts's active-standards
// precedence sentence — this module must stay import-light (no config/yaml
// chain) to hit the <200ms fast-path budget. Keep the wording in sync by
// hand if that sentence changes.
const _PRECEDENCE_TEXT =
  "Precedence: these standards' rules win over conflicting task framing — if a " +
  "rule and the task clash, follow the rule and say so (invariant: apply it and " +
  "write a `decision` note; rule: surface the conflict in one line, then apply). " +
  "This gate fires once; your retry will proceed.";

const _PHASE_ENTRY_TEXT =
  "Standards gate: invoke `sb-implement` before coding — it loads the universal " +
  "base (ponytail + comments + engineering) and the workspace notes. Then retry " +
  "this edit.";

// ---------------------------------------------------------------------------
// fnmatch — minimal port of Python's fnmatch.fnmatch/translate (posix normcase
// is the identity, so matching is case-sensitive; `*` crosses `/` like Python).
// ---------------------------------------------------------------------------

function _translate(pat: string): string {
  let res = "";
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const c = pat[i];
    i += 1;
    if (c === "*") {
      res += ".*";
    } else if (c === "?") {
      res += ".";
    } else if (c === "[") {
      let j = i;
      if (j < n && pat[j] === "!") j += 1;
      if (j < n && pat[j] === "]") j += 1;
      while (j < n && pat[j] !== "]") j += 1;
      if (j >= n) {
        res += "\\[";
      } else {
        let stuff = pat.slice(i, j).replace(/\\/g, "\\\\");
        i = j + 1;
        if (stuff.startsWith("!")) stuff = "^" + stuff.slice(1);
        else if (stuff.startsWith("^")) stuff = "\\" + stuff;
        res += `[${stuff}]`;
      }
    } else {
      res += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return `^(?:${res})$`;
}

function fnmatch(name: string, pat: string): boolean {
  return new RegExp(_translate(pat), "s").test(name);
}

/**
 * `json.dumps` byte-parity: default separators `(", ", ": ")` plus
 * ensure_ascii=True (non-ASCII → \uXXXX, astral chars as surrogate pairs).
 * Used for both the printed hook decision and the persisted state file so
 * output matches the Python gate byte-for-byte.
 */
function _pyJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value).replace(
      /[\u0080-\uffff]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map(_pyJson).join(", ") + "]";
  }
  return (
    "{" +
    Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${_pyJson(k)}: ${_pyJson(v)}`)
      .join(", ") +
    "}"
  );
}

// ---------------------------------------------------------------------------
// Gate proper
// ---------------------------------------------------------------------------

/** Walk up from *start* to the nearest directory containing `.sandbox/`. */
export function findWorkspaceRoot(start: string): string | null {
  let directory = path.resolve(start);
  while (true) {
    if (_isDir(path.join(directory, ".sandbox"))) {
      return directory;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

function _isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function _isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _isDict(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _loadManifest(workspace: string): Record<string, any> | null {
  const manifestPath = path.join(workspace, ".sandbox", "standards.json");
  if (!_isFile(manifestPath)) {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
  return _isDict(data) ? data : null;
}

function _statePath(workspace: string, sessionId: string): string {
  return path.join(workspace, ".sandbox", ".gate", `${sessionId}.json`);
}

/**
 * null is the "unreadable existing file" sentinel — distinct from {} (no
 * state yet, the normal first-ever-edit case). Callers must fail open on null.
 */
function _loadState(workspace: string, sessionId: string): Record<string, any> | null {
  const statePath = _statePath(workspace, sessionId);
  if (!_isFile(statePath)) {
    return {};
  }
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return null;
  }
  return _isDict(data) ? data : null;
}

function _saveState(workspace: string, sessionId: string, state: Record<string, any>): boolean {
  try {
    const statePath = _statePath(workspace, sessionId);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, _pyJson(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete this session's gate state (SessionStart `source` compact/clear —
 * the context was wiped, so delivery must happen again). Best-effort: any
 * failure is silently ignored, matching this module's fail-open doctrine.
 */
export function resetSessionState(workspace: string, sessionId: string): void {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("..")) {
    return;
  }
  try {
    fs.unlinkSync(_statePath(workspace, sessionId));
  } catch {
    // missing_ok=True
  }
}

/** Python-style codepoint sort (Array.sort's default string order matches for ASCII). */
function _sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/**
 * The gate decision table (docs/jit-context-system.md §6). Returns a deny reason, or null to allow.
 *
 * Never throws — every failure mode (no workspace, no manifest, corrupt or
 * unwritable state, malformed inputs) resolves to null (allow), matching the
 * design's fail-open doctrine: a broken gate must never tax every edit.
 */
export function decide(workspaceStart: string, sessionId: string, filePath: string): string | null {
  if (!sessionId || sessionId.includes("/") || sessionId.includes("..")) {
    return null;
  }
  const workspace = findWorkspaceRoot(workspaceStart);
  if (workspace === null) {
    return null;
  }
  const manifest = _loadManifest(workspace);
  if (manifest === null) {
    return null;
  }

  const state = _loadState(workspace, sessionId);
  if (state === null) { // unreadable existing state file -> behave as delivered=all
    return null;
  }

  const relPath = filePath ? path.relative(workspace, filePath) : "";
  const delivered = new Set<string>(state["delivered"] || []);
  const needsPhaseEntry = !state["phase_entry_delivered"];

  let domain: string | null = null;
  const domains: Record<string, any> = _isDict(manifest["domains"]) ? manifest["domains"] : {};
  for (const name of _sorted(Object.keys(domains))) {
    const meta = domains[name];
    if (delivered.has(name) || !_isDict(meta)) {
      continue;
    }
    const globs: unknown[] = meta["applies_to"] || [];
    if (globs.some((glob) => fnmatch(relPath, String(glob)))) {
      domain = name;
      break;
    }
  }

  if (!needsPhaseEntry && domain === null) {
    return null;
  }

  // Coalesce (§6): a first edit that also lands on a governed path carries
  // both payloads in one deny, never two separate denials.
  const parts: string[] = [];
  if (needsPhaseEntry) {
    parts.push(_PHASE_ENTRY_TEXT);
  }
  if (domain !== null) {
    const summary = String((domains[domain] || {})["summary"] || "").trim();
    let domainText =
      `Standards gate: you are editing a path governed by the \`${domain}\` ` +
      "standard, which has not been loaded this session. Invoke the " +
      `\`sb-${domain}-standard\` skill, then retry this edit.`;
    if (summary) {
      domainText += ` Summary: ${summary}.`;
    }
    parts.push(domainText);
  }
  parts.push(_PRECEDENCE_TEXT);

  const newState = {
    phase_entry_delivered: true,
    delivered: _sorted(domain ? new Set([...delivered, domain]) : delivered),
  };
  if (!_saveState(workspace, sessionId, newState)) {
    // ponytail: can't persist -> allow instead of denying forever (an
    // unwritable state dir must never turn into a deny-every-edit loop).
    return null;
  }
  return parts.join("\n");
}

/**
 * `sandbox hooks gate` entrypoint: reads the PreToolUse stdin JSON, prints
 * a deny hookSpecificOutput on deny, prints nothing on allow. Always exits 0
 * — this is a hook, it must never block or fail the tool call.
 */
export function main(): void {
  let data: Record<string, any>;
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    data = _isDict(parsed) ? parsed : {};
  } catch { // a hook must never break the tool call
    data = {};
  }

  const sessionId = String(data["session_id"] || "");
  const filePath = String((data["tool_input"] || {})["file_path"] || "");
  const start = String(data["cwd"] || process.cwd());

  let reason: string | null;
  try {
    reason = decide(start, sessionId, filePath);
  } catch { // same doctrine as above
    reason = null;
  }

  if (reason) {
    console.log(_pyJson({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
  }
}

// `if __name__ == "__main__"` guard: self-execute only when run directly.
const _isMain = (() => {
  try {
    return Boolean(
      process.argv[1] &&
      fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url),
    );
  } catch {
    return false;
  }
})();
if (_isMain) {
  main();
}
