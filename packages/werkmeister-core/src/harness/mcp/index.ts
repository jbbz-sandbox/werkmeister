/**
 * The generic MCP adapter (SW-188): any harness with MCP and skills. It reads
 * `AGENTS.md` and `.agents/skills` (the agentskills.io layout Codex uses), gets
 * its tools from the host daemon over HTTP, and takes no hooks or subagents —
 * docs/harnesses.md says how each harness connects.
 */
import { daemonUrl } from "../../daemon_client.js";
import type { HarnessLayout } from "../types.js";

export const mcpLayout: HarnessLayout = {
  id: "mcp",
  instructionsFile: "AGENTS.md",
  skillsDir: ".agents/skills",
  hooks: {
    available: false,
    reason: "a generic MCP harness has no hooks adapter; use harness: codex for Codex",
  },
  agents: false,
  notice: () =>
    "\n## Harness\n\n" +
    "This workspace was generated for the `mcp` harness. Werkmeister's tools come from the MCP " +
    `server \`werkmeister\` at ${daemonUrl()}/mcp (how to register it: docs/harnesses.md in the ` +
    "werkmeister repo). Hooks are unavailable on this harness: werkmeister's session-start " +
    "context, standards gate, PR guard and agent state do not run here (Codex: use `harness: codex`). " +
    "Open PRs only with " +
    "`werkmeister pr open`.\n",
};
