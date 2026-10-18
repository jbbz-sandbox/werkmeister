/**
 * Entry point. Pass `--stdio` to run over stdio (for Claude Desktop); with no
 * flag it starts a Streamable HTTP server instead (handy for local testing
 * with the ext-apps basic-host).
 *
 *   node dist/main.js --stdio    # Claude Desktop (stdio)
 *   node dist/main.js            # HTTP on PORT (default 3001)
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createBrowserUiRouter } from "./lib/browser-ui.js";
import { createServer } from "./server.js";

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel on stdio — diagnostics must go to stderr.
  console.error("[workspaces] MCP server running on stdio");
}

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  // Bind loopback by default: the tools this server exposes (Docker, VS Code,
  // kubectl, claude, workspace create/remove) are unauthenticated, so it must
  // never be reachable from the network. HOST=0.0.0.0 exists for one case: a
  // sandbox container, where the listener has to be reachable through Docker's
  // published port and the container network is the isolation boundary.
  const host = process.env.HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host });
  // Restrict CORS to localhost origins so a website the user visits can't invoke
  // tools cross-origin. Same-origin (no Origin header) and other localhost dev
  // ports (e.g. the ext-apps basic-host) still work; real sites are refused.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        let originHost: string | null = null;
        try {
          originHost = new URL(origin).hostname;
        } catch {
          /* malformed Origin → untrusted */
        }
        cb(null, originHost === "localhost" || originHost === "127.0.0.1" || originHost === "::1");
      },
    }),
  );

  // Browser-accessible dashboard at GET / (+ POST /api/tool), served alongside
  // the MCP endpoint at /mcp. The fallback for hosts that don't render ui://.
  app.use(await createBrowserUiRouter());

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, host, (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`[workspaces] MCP server listening on http://localhost:${port}/mcp`);
    console.error(`[workspaces] workspaces dashboard: http://localhost:${port}/`);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  if (process.argv.includes("--stdio")) {
    await startStdio();
  } else {
    await startHttp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
