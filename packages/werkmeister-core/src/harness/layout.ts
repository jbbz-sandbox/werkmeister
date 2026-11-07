/**
 * Which harness reads a workspace, and where (proposal § 4.3, SW-188). Chosen per
 * workspace by `harness:` in workspace.yml, like `context_strategy`; the writers
 * of the context layer ask `harnessLayoutFor`, and a workspace's sessions `harnessFor`;
 * neither caller names a harness.
 */
import { SandboxError } from "../errors.js";
import { success, warn } from "../reporter.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { readWorkspaceField } from "../workspace_prompts.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { claudeAdapter } from "./claude/index.js";
import { codexAdapter } from "./codex/adapter.js";
import { codexLayout } from "./codex/index.js";
import { mcpLayout } from "./mcp/index.js";
import { opencodeAdapter } from "./opencode/index.js";
import { opencodeLayout } from "./opencode/layout.js";
import { HARNESS_IDS, type HarnessAdapter, type HarnessId, type HarnessLayout } from "./types.js";

export const claudeLayout: HarnessLayout = {
  id: "claude",
  instructionsFile: "CLAUDE.md",
  skillsDir: ".claude/skills",
  hooks: { available: true },
  agents: true,
  questionTool: "AskUserQuestion",
  notice: () => "",
};

const REGISTRY: Record<HarnessId, HarnessLayout> = {
  claude: claudeLayout,
  mcp: mcpLayout,
  codex: codexLayout,
  opencode: opencodeLayout,
};

export function harnessLayoutById(id: HarnessId): HarnessLayout {
  return REGISTRY[id];
}

/** Absent or blank → claude. Anything else must name a registered harness. */
export function parseHarnessId(value: unknown): HarnessId {
  const id = value === undefined || value === null ? "" : String(value).trim();
  if (!id) return HARNESS_IDS[0];
  if ((HARNESS_IDS as readonly string[]).includes(id)) return id as HarnessId;
  throw new SandboxError(
    `Unknown harness '${id}' in workspace.yml — expected one of: ${HARNESS_IDS.join(", ")}`,
    "UNKNOWN_HARNESS",
  );
}

/** The layout of the harness that reads *workspaceRoot*. */
export function harnessLayoutFor(workspaceRoot: string): HarnessLayout {
  return REGISTRY[parseHarnessId(readWorkspaceField(workspaceRoot, "harness"))];
}

// A generic MCP harness has no session store werkmeister reads; it keeps Claude's (idle) readers.
const ADAPTERS: Record<HarnessId, HarnessAdapter> = {
  claude: claudeAdapter,
  mcp: claudeAdapter,
  codex: codexAdapter,
  opencode: opencodeAdapter,
};

/** The `harness:` of *workspaceRoot*; an unknown value reads as claude, so one bad workspace.yml can't fail the status sweep. */
export function harnessIdOf(workspaceRoot: string): HarnessId {
  try {
    return parseHarnessId(readWorkspaceField(workspaceRoot, "harness"));
  } catch {
    return HARNESS_IDS[0];
  }
}

/** The session adapter of the harness that reads *workspaceRoot* (a reconcile dir has no workspace.yml: Claude). */
export function harnessFor(workspaceRoot: string): HarnessAdapter {
  return ADAPTERS[harnessIdOf(workspaceRoot)];
}

/**
 * True when the workspace takes Claude Code hooks, which the caller then writes. A harness
 * with its own hook files gets them written here and answers false, so no caller writes
 * `.claude/settings.json` for it; either way says what does not run, never silently.
 */
export function hooksAvailable(workspaceRoot: string): boolean {
  const { id, hooks } = harnessLayoutFor(workspaceRoot);
  if (hooks.available === true) return true;
  if (hooks.available === "own") {
    success(`Wrote ${hooks.write(workspaceRoot)}`);
    warn(`hooks: partial on ${id} (${hooks.missing} do not run)`);
  } else warn(`hooks: unavailable on ${id} (${hooks.reason})`);
  return false;
}
