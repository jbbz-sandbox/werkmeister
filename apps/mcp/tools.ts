/**
 * The twenty tool registrations.
 *
 * Every one is a thin adapter: validate with zod, call the core function inside
 * a collecting reporter, return the transcript as `content` and the typed
 * result as `structuredContent`. Nothing here decides anything a verb should
 * decide — if a registration grows a branch about *what the verb does*, that
 * logic belongs in `sandbox-core` (predecessor spec §4).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerTools(_server: McpServer): void {
  // Filled in by the three tool tasks.
}
