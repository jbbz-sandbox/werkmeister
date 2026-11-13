/**
 * The server factory, apart from the daemon entry (main.ts). A bundle that
 * inlines main.ts becomes its entry file, so main.ts's run-as-entry check passes
 * there and starts a daemon: the dashboard imports this module instead.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDaemonTools, registerSchedulerTool } from "./daemon_tools.js";
import { connectInMemoryClient } from "./lib/in_memory.js";
import { WORKSPACE_SCOPED_TOOLS } from "./scope.js";
import { registerTools } from "./tools.js";
import { registerWorkspaceTools } from "./workspace_tools.js";

export { connectInMemoryClient };

/**
 * With `scoped`, only the tools a per-workspace token may call are registered;
 * with `scheduler`, also the scheduler's internal ops (the daemon's `/api/tool`).
 */
export function createServer(opts: { scoped?: boolean; scheduler?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "werkmeister", version: "0.1.0" });
  registerTools(server);
  registerWorkspaceTools(server);
  registerDaemonTools(server);
  if (opts.scheduler) registerSchedulerTool(server);
  if (opts.scoped) {
    // The SDK's private registry is the only list of what was registered.
    const registered = (
      server as unknown as { _registeredTools: Record<string, { remove(): void }> }
    )._registeredTools;
    for (const [name, tool] of Object.entries(registered)) {
      if (!WORKSPACE_SCOPED_TOOLS.has(name)) tool.remove();
    }
  }
  return server;
}
