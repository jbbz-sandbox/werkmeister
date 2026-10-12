/**
 * `sandbox hooks pr-guard` — PreToolUse hook installed in every workspace
 * (hooks_gen.ts). Inside a workspace, a PR opens only through `sandbox pr
 * open`, which runs the gate and records the URL; this denies the other ways
 * in — `gh pr create` in Bash (what `/create-pr` and
 * `finishing-a-development-branch` run) and the GitHub MCP's
 * create_pull_request. `sandbox pr open` spawns `gh` itself, never through the
 * Bash tool, so it is never seen here.
 *
 * Builtins only and fail-open, like gate.ts: it runs on every Bash call.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The workspace root: nearest ancestor holding `.sandbox/workspace.yml`. Not
 * gate.ts's `findWorkspaceRoot` — a code worktree has its own `.sandbox/`
 * (the repo's registry fragment), so a walk to any `.sandbox/` stops too early.
 */
export function findRecordRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".sandbox", "workspace.yml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function prFileDirName(root: string): string {
  try {
    const names = fs.readdirSync(path.join(root, "stages")).sort();
    const dir = names.find((n) => /^\d+_propose$/.test(n)) ?? names.find((n) => /^\d+_ship$/.test(n));
    return dir ? `stages/${dir}/output/` : "the propose stage's output/";
  } catch {
    return ".sandbox/notes/";
  }
}

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const MCP_CREATE_PR = /create_pull_request$/;

/** The deny reason for this PreToolUse input, or null to allow. */
export function decide(input: Record<string, any>): string | null {
  const root = findRecordRoot(String(input["cwd"] || process.cwd()));
  if (!root) return null;
  const tool = String(input["tool_name"] || "");
  const command = String((input["tool_input"] || {})["command"] || "");
  const opensPr = (tool === "Bash" && GH_PR_CREATE.test(command)) || MCP_CREATE_PR.test(tool);
  if (!opensPr) return null;
  // A workspace generated before the rules file existed has neither path; point at the docs then.
  const rules =
    ["_shared/pr-rules.md", ".sandbox/pr-rules.md"].find((p) => fs.existsSync(path.join(root, p))) ??
    "docs/workspace-lifecycle.md in the sandbox repo";
  return (
    `Inside sandbox workspace \`${path.basename(root)}\`, PRs open only through \`sandbox pr open\`: ` +
    "it runs the pre-PR gate and records the URL. Write the PR file in " +
    `\`${prFileDirName(root)}\`, have the person set \`status: approved\`, then run \`sandbox pr open\`. ` +
    `Rules: \`${rules}\`.`
  );
}

/** Hook entrypoint: deny JSON on stdout, nothing on allow, always exit 0. */
export function main(): void {
  let reason: string | null = null;
  try {
    const raw = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) reason = decide(parsed);
  } catch { // a hook must never break the tool call
    reason = null;
  }
  if (reason) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }));
  }
}
