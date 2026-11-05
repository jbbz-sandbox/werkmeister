/**
 * Which harness reads a workspace, and where (proposal § 4.3, SW-188). Chosen per
 * workspace by `harness:` in workspace.yml, like `context_strategy`; the writers
 * of the context layer ask `harnessLayoutFor` and never name a harness. Sessions
 * (ask, sendTurn, transcripts) stay Claude's in `HarnessAdapter`.
 */
import { SandboxError } from "../errors.js";
import { warn } from "../reporter.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { readWorkspaceField } from "../workspace_prompts.js";
import { codexLayout } from "./codex/index.js";
import { mcpLayout } from "./mcp/index.js";
import { HARNESS_IDS, type HarnessId, type HarnessLayout } from "./types.js";

export const claudeLayout: HarnessLayout = {
  id: "claude",
  instructionsFile: "CLAUDE.md",
  skillsDir: ".claude/skills",
  hooks: { available: true },
  agents: true,
  notice: () => "",
};

const REGISTRY: Record<HarnessId, HarnessLayout> = {
  claude: claudeLayout,
  mcp: mcpLayout,
  codex: codexLayout,
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

/** True when the workspace's harness takes hooks; otherwise says why none were written, never silently. */
export function hooksAvailable(workspaceRoot: string): boolean {
  const { id, hooks } = harnessLayoutFor(workspaceRoot);
  if (!hooks.available) warn(`hooks: unavailable on ${id} (${hooks.reason})`);
  return hooks.available;
}
