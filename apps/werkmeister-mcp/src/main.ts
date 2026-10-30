/**
 * The one werkmeister MCP server (SW-48): every tool, on every transport.
 *
 *   node dist/main.js --stdio    # a host-local client (Claude Desktop, the plugin, host CLI)
 *   node dist/main.js            # Streamable HTTP on PORT (default 3002)
 *
 * The dashboard imports {@link createServer} for its browser page's `/api/tool`,
 * so importing this module must not start a server.
 *
 * Over HTTP this is also the host daemon (SW-184): `/api/tool` and
 * `/api/logs/stream` serve the thin clients (the VS Code extension, the CLI's
 * SessionEnd stop), and a per-workspace token narrows `/mcp` to one workspace.
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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { composeLogsStream } from "werkmeister-core/compose";
import { DEFAULT_DAEMON_PORT } from "werkmeister-core/daemon_client";
import { SandboxError } from "werkmeister-core/errors";
import { ownScheduler } from "werkmeister-core/scheduler_client";
import { registerDaemonTools, registerSchedulerTool } from "./daemon_tools.js";
import { resolveFeature, SCOPE_HEADER } from "./lib/feature.js";
import { connectInMemoryClient } from "./lib/in_memory.js";
import { readOrCreateToken, type Scope, scopeOf } from "./lib/token.js";
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

const scopeOfReq = (res: Response): Scope => res.locals["scope"] as Scope;

/**
 * Replace whatever scope header the client sent with the daemon's own. Both
 * views: Express reads `headers`, while the SDK's transport rebuilds the
 * request (via @hono/node-server) from `rawHeaders`, and that copy is what
 * reaches a tool's `requestInfo`.
 */
function setScopeHeader(req: Request, name: string | undefined): void {
  delete req.headers[SCOPE_HEADER];
  const raw: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() !== SCOPE_HEADER) {
      raw.push(req.rawHeaders[i], req.rawHeaders[i + 1]);
    }
  }
  if (name !== undefined) {
    req.headers[SCOPE_HEADER] = name;
    raw.push(SCOPE_HEADER, name);
  }
  req.rawHeaders = raw;
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

async function startStdio(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel on stdio — diagnostics must go to stderr.
  console.error("[werkmeister-mcp] MCP server running on stdio");
}

async function startHttp(): Promise<void> {
  // This process is the host daemon: it runs the scheduler, every other process asks it (SW-185).
  ownScheduler();
  const port = parseInt(
    process.env.PORT ?? process.env.WERKMEISTER_MCP_PORT ?? String(DEFAULT_DAEMON_PORT),
    10,
  );
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

  // One predicate, one place. Ahead of the routes so nothing is reachable
  // without it, and after the Origin check so a browser gets no 401 oracle.
  // The scope header is the daemon's to set: a client's own value never survives.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const scope = scopeOf(req.headers.authorization, token, host);
    if (scope === null) {
      res.status(401).end();
      return;
    }
    setScopeHeader(req, scope.scope === "workspace" ? scope.name : undefined);
    res.locals["scope"] = scope;
    next();
  });

  // Host thin clients (VS Code, the SessionEnd stop): plain JSON instead of the
  // MCP handshake on every 5 s poll. One long-lived in-process client; its calls
  // carry no headers, so this route is machine-token only.
  const toolClient = connectInMemoryClient(createServer({ scheduler: true }), "werkmeister-daemon");
  app.post("/api/tool", express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    if (scopeOfReq(res).scope !== "machine") {
      res.status(403).json({ error: "/api/tool needs the machine token", code: "SCOPE" });
      return;
    }
    const { name, arguments: args } = (req.body ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name) {
      res.status(400).json({ error: "missing tool name", code: "ARGS" });
      return;
    }
    try {
      const result = (await (
        await toolClient
      ).callTool(
        { name, arguments: args ?? {} },
        undefined,
        // The SDK's 60 s default cuts off a grant that starts containers, or a close-out.
        { timeout: 15 * 60_000 },
      )) as CallToolResult;
      const code = (result.structuredContent as { code?: string } | undefined)?.code;
      if (result.isError) {
        res.status(400).json({ error: textOf(result), code: code ?? "TOOL" });
        return;
      }
      res.json({ structuredContent: result.structuredContent ?? null, text: textOf(result) });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message, code: "INTERNAL" });
    }
  });

  // Follow logs (SW-184): SSE, as the dashboard's /api/session/stream. Each
  // chunk is a JSON string so embedded newlines can't split an event.
  app.get("/api/logs/stream", (req: Request, res: Response) => {
    const q = (k: string) =>
      typeof req.query[k] === "string" ? (req.query[k] as string) : undefined;
    let feature: string;
    try {
      ({ feature } = resolveFeature(q("feature"), req.headers));
    } catch (e) {
      const code = e instanceof SandboxError ? e.code : "WORKSPACE";
      res.status(code === "SCOPE" ? 403 : 400).json({ error: (e as Error).message, code });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const tail = composeLogsStream(feature, q("service") ?? null, (chunk) => {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });
    req.on("close", () => tail.stop());
    tail.done.then(
      () => res.end("event: end\ndata: \n\n"),
      (e: Error) => res.end(`event: error\ndata: ${JSON.stringify(e.message)}\n\n`),
    );
  });

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer({ scoped: scopeOfReq(res).scope === "workspace" });
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
    const rssMb = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
    console.error(
      `[werkmeister-mcp] listening on http://${host}:${port}/mcp (pid ${process.pid}, rss ${rssMb} MB)`,
    );
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
