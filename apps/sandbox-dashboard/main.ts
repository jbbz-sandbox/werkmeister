/**
 * Entry point. Pass `--stdio` to run over stdio (for Claude Desktop); with no
 * flag it starts a Streamable HTTP server instead (handy for local testing
 * with the ext-apps basic-host).
 *
 *   node dist/main.js --stdio    # Claude Desktop (stdio)
 *   node dist/main.js            # HTTP on PORT (default 3001)
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { createServer } from "./server.js";
import { createBrowserUiRouter } from "./lib/browser-ui.js";

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel on stdio — diagnostics must go to stderr.
  console.error("[sandbox-workspace] MCP server running on stdio");
}

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3001", 10);
  // Bind loopback only: the tools this server exposes (Docker, VS Code, kubectl,
  // claude, workspace create/remove) are unauthenticated, so it must never be
  // reachable from the network.
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  // Restrict CORS to localhost origins so a website the user visits can't invoke
  // tools cross-origin. Same-origin (no Origin header) and other localhost dev
  // ports (e.g. the ext-apps basic-host) still work; real sites are refused.
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        let host: string | null = null;
        try {
          host = new URL(origin).hostname;
        } catch {
          /* malformed Origin → untrusted */
        }
        cb(null, host === "localhost" || host === "127.0.0.1" || host === "::1");
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

  const httpServer = app.listen(port, "127.0.0.1", (err?: Error) => {
    if (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
    console.error(`[sandbox-workspace] MCP server listening on http://localhost:${port}/mcp`);
    console.error(`[sandbox-workspace] workspaces dashboard: http://localhost:${port}/`);
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
