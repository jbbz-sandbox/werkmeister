/**
 * `werkmeister hooks pr-guard` — PreToolUse hook installed in every workspace
 * (hooks_gen.ts). Inside a workspace, a PR opens only through `werkmeister pr
 * open`, which runs the gate and records the URL; this denies the other ways
 * in — `gh pr create` in Bash (what `/create-pr` and
 * `finishing-a-development-branch` run) and the GitHub MCP's
 * create_pull_request. `werkmeister pr open` spawns `gh` itself, never through the
 * Bash tool, so it is never seen here.
 *
 * Builtins only and fail-open, like gate.ts: it runs on every Bash call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { DOT_DIR, dotDir } from "./dot_dir.js";

/**
 * The workspace root: nearest ancestor holding `.werkmeister/workspace.yml`. Not
 * gate.ts's `findWorkspaceRoot` — a code worktree has its own `.werkmeister/`
 * (the repo's registry fragment), so a walk to any `.werkmeister/` stops too early.
 */
export function findRecordRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dotDir(dir), "workspace.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Mirrors pr_lifecycle.ts's prFileDir, which this fast path can't import.
function prFileDirName(root: string): string {
  try {
    const names = fs
      .readdirSync(path.join(root, "stages"))
      .filter((n) => /^\d+_/.test(n))
      .sort();
    const dir =
      names.find((n) => /^\d+_propose$/.test(n)) ??
      names.find((n) => /^\d+_ship$/.test(n)) ??
      names.at(-1);
    return dir ? `stages/${dir}/output/` : "the last stage's output/";
  } catch {
    return `${path.basename(dotDir(root))}/notes/`;
  }
}

// `<<<` is a here-string, not a heredoc. The body runs to a line holding only the word.
const HEREDOC =
  /(?<!<)<<(?!<)-?\s*(['"]?)(\w+)\1([^\n]*)(?:\n(?:[\s\S]*?\n)?\t*\2(?=\n|$)|[\s\S]*$)/g;
const QUOTED = /'[^']*(?:'|$)|"(?:[^"\\]|\\[\s\S])*(?:"|$)/g;
// The command word at a statement start, after any env assignments or prefix words.
const GH_PR_CREATE =
  /(?:^|[;&|({\n`])\s*(?:(?:\w+=\S*|command|exec|env|then|do|else)\s+)*gh\s+pr\s+create\b/;
const MCP_CREATE_PR = /create_pull_request$/;

/**
 * Whether *command* runs `gh pr create`, not merely mentions it in a quoted
 * string, heredoc body or grep pattern (SW-83).
 * ponytail: `bash -c "..."` and `eval "..."` are quoted, so they pass; parse
 * those strings too if the guard ever has to be a boundary rather than a steer.
 */
export function opensPr(command: string): boolean {
  return GH_PR_CREATE.test(command.replace(HEREDOC, "$3").replace(QUOTED, "_"));
}

/** The workspace's PR rules page, relative to *root*; the docs when it predates one. */
export function prRulesPath(root: string): string {
  return (
    ["_shared/pr-rules.md", `${DOT_DIR}/pr-rules.md`].find((p) =>
      fs.existsSync(path.join(root, p)),
    ) ?? "docs/workspace-lifecycle.md in the werkmeister repo"
  );
}

/** The deny reason for this PreToolUse input, or null to allow. */
export function decide(input: Record<string, any>): string | null {
  const root = findRecordRoot(String(input["cwd"] || process.cwd()));
  if (!root) return null;
  const tool = String(input["tool_name"] || "");
  const command = String(input["tool_input"]?.["command"] || "");
  if (!((tool === "Bash" && opensPr(command)) || MCP_CREATE_PR.test(tool))) return null;
  const rules = prRulesPath(root);
  return (
    `Inside workspace \`${path.basename(root)}\`, PRs open only through \`werkmeister pr open\`: ` +
    "it runs the pre-PR gate and records the URL. Write the PR file in " +
    `\`${prFileDirName(root)}\`, have the person set \`status: approved\`, then run \`werkmeister pr open\`. ` +
    `Rules: \`${rules}\`.`
  );
}

/** Hook entrypoint: deny JSON on stdout, nothing on allow, always exit 0. */
export function main(): void {
  let reason: string | null = null;
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      reason = decide(parsed);
  } catch {
    // a hook must never break the tool call
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
