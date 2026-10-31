/**
 * The localhost workspaces dashboard: the browser page at `GET /` and the
 * `/api/*` bridge it calls. The MCP server is `apps/werkmeister-mcp` (`werkmeister internal mcp`);
 * this app only renders.
 *
 *   node dist/main.js            # http://localhost:$PORT/ (default 3001)
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { createBrowserUiRouter } from "./lib/browser-ui.js";

async function main(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  // Loopback by default: `/api/tool` reaches host-level tools (Docker, VS Code,
  // kubectl, claude, workspace create/remove) with no authentication. HOST=0.0.0.0
  // exists for one case: a workspace container, where the listener has to be
  // reachable through Docker's published port and the container network is the
  // isolation boundary.
  const host = process.env.HOST ?? "127.0.0.1";
  // createMcpExpressApp's Host-header check is the DNS-rebinding guard for a loopback bind.
  const app = createMcpExpressApp({ host });
  app.use(await createBrowserUiRouter());

  const httpServer = app.listen(port, host, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`[workspaces] workspaces dashboard: http://localhost:${port}/`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
