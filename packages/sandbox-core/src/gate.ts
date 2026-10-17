/**
 * PreToolUse standards gate — docs/jit-context-system.md §6.
 *
 * Denies the first governed `Edit`/`Write` per session x domain, carrying the
 * loading instructions in the deny reason, then allows everything after
 * (fail-open, deny-once-with-payload — §2).
 *
 * When the manifest carries `phase_gate` (the work type's pre-implementation
 * gate), source edits are denied *until* a matching note exists in
 * `.sandbox/notes/`. That deny repeats and records no state, because it is
 * an approval gate, not a delivery gate.
 *
 * Deliberately dependency-light (node builtins only — no commander/yaml/nunjucks,
 * nothing that touches the config/YAML chain): Phase 0 measured the normal
 * `sandbox` entrypoint at 250-460ms cold, well past this design's <200ms budget
 * for a hook that fires on every Edit/Write. `apps/cli/src/lib/gate.ts` is a
 * six-line esbuild entry that calls {@link main}, so the hook still runs
 * `node dist/lib/gate.js` and bypasses the heavyweight main import chain. The
 * normal `sandbox hooks gate` CLI path (manual runs, tests) imports this same
 * module — one implementation either way.
 *
 * **Keep this module import-light.** Anything that pulls the config/YAML chain
 * in here lands in that entry's bundle and spends the budget; the measured
 * cost is in the PR that moved it (median 80ms before, against 200ms).
 */

import * as fs from "node:fs";
import * as path from "node:path";

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
// fnmatch — glob matching for the manifest's file globs. Case-sensitive, and
// `*` crosses `/` (so `**` behaves the same as `*`).
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

/** `.sandbox/standards.json` as a dict, or null when missing/unreadable — never throws. */
export function loadManifest(workspace: string): Record<string, any> | null {
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
    fs.writeFileSync(statePath, JSON.stringify(state));
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
    // already gone
  }
}

function _sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

// ---------------------------------------------------------------------------
// Phase gate (docs/jit-context-system.md §6) — deny-until, no state.
// ---------------------------------------------------------------------------

/**
 * The frontmatter `status:` of a note: the value, null when there is no
 * status line, or undefined when there is no `---` block (unparseable — the
 * caller fails open). A regex, not YAML: this module stays builtins-only.
 */
function _noteStatus(text: string): string | null | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!block) {
    return undefined;
  }
  const status = /^status:\s*["']?([^\s"'#]+)/m.exec(block[1]);
  return status ? status[1].toLowerCase() : null;
}

/** True when a live note satisfies *gate*, or when the check cannot be made (fail-open). */
function _phaseGateSatisfied(workspace: string, gate: Record<string, any>): boolean {
  const note = String(gate["note"] ?? "");
  if (!/^[a-z]+$/.test(note)) {
    return true;
  }
  const want = gate["status"] ? String(gate["status"]).toLowerCase() : null;
  const dir = path.join(workspace, ".sandbox", "notes");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (exc) {
    // No notes dir yet means no notes — deny. Anything else is unreadable — allow.
    return (exc as NodeJS.ErrnoException).code !== "ENOENT";
  }
  const pattern = new RegExp(`^\\d{3}-${note}-.+\\.md$`);
  for (const name of names) {
    if (!pattern.test(name)) {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      return true;
    }
    const status = _noteStatus(text);
    if (status === undefined) {
      return true;
    }
    if (status === "superseded" || status === "graduated") {
      continue;
    }
    if (want === null || status === want) {
      return true;
    }
  }
  return false;
}

function _phaseGateText(gate: Record<string, any>): string {
  const note = String(gate["note"]);
  if (gate["status"]) {
    const status = String(gate["status"]);
    return (
      `Phase gate: no \`${note}\` note in \`.sandbox/notes/\` has \`status: ${status}\`, so ` +
      "source edits wait for an approved design. Invoke `sb-research`, present the design to " +
      `the user, and when they approve write \`NNN-${note}-<slug>.md\` with ` +
      `\`status: ${status}\` recording what was approved. Then retry this edit. Edits under ` +
      "`.sandbox/` are not gated."
    );
  }
  return (
    `Phase gate: no \`${note}\` note in \`.sandbox/notes/\` names the root cause yet. Invoke ` +
    `\`sb-research\`, reproduce the problem, and write \`NNN-${note}-<slug>.md\` stating the ` +
    "root cause. Then retry this edit. Edits under `.sandbox/` are not gated."
  );
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
  const manifest = loadManifest(workspace);
  if (manifest === null) {
    return null;
  }

  const state = _loadState(workspace, sessionId);
  if (state === null) {
    // unreadable existing state file -> behave as delivered=all
    return null;
  }

  const relPath = filePath ? path.relative(workspace, filePath) : "";

  // 2a. Phase gate (§6): deny-until the work type's note exists. Before the
  // standards logic, records nothing, and never gates `.sandbox/` — the note
  // that satisfies it must be writable.
  const phaseGate = manifest["phase_gate"];
  if (
    _isDict(phaseGate) &&
    relPath &&
    relPath !== ".." &&
    !relPath.startsWith(".." + path.sep) &&
    !path.isAbsolute(relPath) &&
    !relPath.startsWith(".sandbox" + path.sep) &&
    !_phaseGateSatisfied(workspace, phaseGate)
  ) {
    return _phaseGateText(phaseGate);
  }

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
    const summary = String(domains[domain]?.["summary"] || "").trim();
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
  } catch {
    // a hook must never break the tool call
    data = {};
  }

  const sessionId = String(data["session_id"] || "");
  const filePath = String(data["tool_input"]?.["file_path"] || "");
  const start = String(data["cwd"] || process.cwd());

  let reason: string | null;
  try {
    reason = decide(start, sessionId, filePath);
  } catch {
    // same doctrine as above
    reason = null;
  }

  if (reason) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
    );
  }
}
