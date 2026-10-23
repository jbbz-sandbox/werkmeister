/**
 * The one werkmeister MCP server (SW-48): every tool, on every transport.
 *
 *   node dist/main.js --stdio    # a host-local client (Claude Desktop, the plugin, host CLI)
 *   node dist/main.js            # Streamable HTTP on PORT (default 3002)
 *
 * The dashboard imports {@link createServer} for its browser page's `/api/tool`,
 * so importing this module must not start a server.
 *
 * This server holds the privilege a container is denied: it runs on the host,
 * with the host's Docker daemon, and exposes only the verbs. Everything that
 * keeps that honest lives below — the bind, the Origin refusal, and the bearer
 * token.
 */

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { NextFunction, Request, Response } from "express";

import { authorized, readOrCreateToken } from "./lib/token.js";
import { registerTools } from "./tools.js";
import { registerWorkspaceTools } from "./workspace_tools.js";

export function createServer(): McpServer {
  const server = new McpServer({ name: "werkmeister", version: "0.1.0" });
  registerTools(server);
  registerWorkspaceTools(server);
  return server;
}

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel on stdio — diagnostics must go to stderr.
  console.error("[sandbox-mcp] MCP server running on stdio");
}

async function startHttp(): Promise<void> {
  const port = parseInt(process.env.PORT ?? "3002", 10);
  // Loopback by default. HOST=0.0.0.0 is the container case: the container
  // network is the isolation boundary and Docker's published port is the only
  // way in — and on that bind the token below stops being optional.
  const host = process.env.HOST ?? "127.0.0.1";
  const token = readOrCreateToken();
  const app = createMcpExpressApp({ host });

  // No browser UI here, so any Origin at all is a browser reaching a server
  // that has none. Refusing outright is both less code than an allowlist and
  // strictly safer; same-origin and non-browser clients send no Origin.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers.origin !== undefined) {
      res.status(403).end();
      return;
    }
    next();
  });

  // One predicate, one place. Ahead of the route so nothing is reachable
  // without it, and after the Origin check so a browser gets no 401 oracle.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!authorized(req.headers.authorization, token, host)) {
      res.status(401).end();
      return;
    }
    next();
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    // Closing the server on disconnect is also the abort: Protocol._onclose()
    // aborts every in-flight request handler's controller, which is the
    // `extra.signal` the six long-running tools pass into core. A client that
    // hangs up stops the work — the remote equivalent of Ctrl-C.
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

  // Node's listening callback takes no arguments -- a bind failure
  // (EADDRINUSE, etc.) arrives as an "error" event on the server instead, so
  // that's where the failure has to be handled. stdout is the JSON-RPC
  // transport on --stdio, so diagnostics still go to stderr here too.
  const httpServer = app.listen(port, host, () => {
    console.error(`[sandbox-mcp] listening on http://${host}:${port}/mcp`);
  });
  httpServer.on("error", (err: Error) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  if (process.argv.includes("--stdio")) {
    await startStdio();
  } else {
    await startHttp();
  }
}

// realpath on both sides: a launcher may reach this file through a symlink.
const isEntry =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
