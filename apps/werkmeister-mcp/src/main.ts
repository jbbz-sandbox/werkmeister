/**
 * The one werkmeister MCP server (SW-48): every tool, on every transport.
 *
 *   node dist/main.js            # Streamable HTTP on PORT (default 3002): the host daemon
 *   node dist/proxy.js           # stdio, per session: a thin proxy to the daemon (SW-344)
 *
 * The dashboard imports {@link createServer} for its browser page's `/api/tool`
 * from server.ts, never from here: bundled, this module starts the daemon.
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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { composeLogsStream } from "werkmeister-core/compose";
import {
  BUILD_HEADER,
  buildOf,
  DEFAULT_DAEMON_PORT,
  STREAM_HEADER,
} from "werkmeister-core/daemon_client";
import { SandboxError } from "werkmeister-core/errors";
import { githubIngestConfig } from "werkmeister-core/github_ingest";
import { watchPrs } from "werkmeister-core/pr_lifecycle";
import { ownScheduler } from "werkmeister-core/scheduler_client";
import { readQueue } from "werkmeister-core/scheduler_state";
import { DAEMON_LABEL } from "werkmeister-core/web_servers";
import { sqsDeps, startGithubIngest } from "./github_ingest.js";
import { resolveFeature, SCOPE_HEADER } from "./lib/feature.js";
import { restartGuard } from "./lib/self_restart.js";
import { readOrCreateToken, type Scope, scopeOf } from "./lib/token.js";
import { connectInMemoryClient, createServer } from "./server.js";

export { connectInMemoryClient, createServer };

const scopeOfReq = (res: Response): Scope => res.locals["scope"] as Scope;
// Test knob; the default stays well under undici's 300 s bodyTimeout.
const HEARTBEAT_MS = Number(process.env.WERKMEISTER_DAEMON_HEARTBEAT_MS) || 60_000;

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

async function startHttp(): Promise<void> {
  // This process is the host daemon: it runs the scheduler, every other process asks it (SW-185).
  ownScheduler();
  const port = parseInt(
    process.env.PORT ?? process.env.WERKMEISTER_MCP_PORT ?? String(DEFAULT_DAEMON_PORT),
    10,
  );
  // Loopback by default. HOST=0.0.0.0 is the container case: the container
  // network is the isolation boundary and Docker's published port is the only
  // way in. The token below is required on either bind (SW-631).
  const host = process.env.HOST ?? "127.0.0.1";
  const token = readOrCreateToken();
  const app = createMcpExpressApp({ host });
  const guard = restartGuard({
    entry: fs.realpathSync(process.argv[1]),
    build: buildOf,
    queued: () => readQueue().length,
    // launchd sets XPC_SERVICE_NAME to the job label; a PID-file daemon has nothing to restart it.
    exit:
      process.env.XPC_SERVICE_NAME === DAEMON_LABEL
        ? () => {
            httpServer.close(() => process.exit(0));
            // Only uncounted log follows can be left open here; close() would wait on them forever.
            httpServer.closeAllConnections();
          }
        : undefined,
    log: (msg) => console.error(`[werkmeister-mcp] ${msg}`),
  });
  setInterval(() => guard.check(), 5000).unref();

  const log = (msg: string) => console.error(`[werkmeister-mcp] ${msg}`);
  const ingest = githubIngestConfig();
  if (ingest) {
    // Ingest is optional: a missing SDK must never keep the daemon from serving.
    try {
      startGithubIngest(ingest.queueUrl, {
        ...(await sqsDeps(ingest)),
        watch: (opts) => watchPrs(opts),
        track: (work) => guard.track(work),
        log,
      });
      log(`github ingest: polling ${ingest.queueUrl}`);
    } catch (e) {
      log(`github ingest: off, could not start: ${(e as Error).message}`);
    }
  } else log("github ingest: off (no github_ingest block in ~/.werkmeister/config.yaml)");

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
    const scope = scopeOf(req.headers.authorization, token);
    if (scope === null) {
      res.status(401).end();
      return;
    }
    setScopeHeader(req, scope.scope === "workspace" ? scope.name : undefined);
    res.locals["scope"] = scope;
    if (guard.loaded) res.setHeader(BUILD_HEADER, guard.loaded);
    // A CLI that sees another build on disk is a cue not to wait for the next poll;
    // checked once this response is done, so the exit can't cut the request carrying it.
    const sent = req.headers[BUILD_HEADER];
    if (sent && sent !== guard.loaded) res.on("close", () => guard.check());
    next();
  });

  app.get("/api/status", (_req: Request, res: Response) => {
    res.json({ pid: process.pid, ...guard.status() });
  });

  // Stateless /mcp has nothing to push, and a client's standalone SSE GET would stay open for
  // the whole session, counted in flight below, so no build restart could ever go idle (SW-344).
  // 405 is the spec's "no stream here"; the SDK client then stops asking.
  app.get("/mcp", (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").end();
  });

  // Calls the restart must wait for. Log follows are left out: one can stay open for hours.
  app.use(["/api/tool", "/mcp"], (_req: Request, res: Response, next: NextFunction) => {
    void guard.track(
      () =>
        new Promise<void>((done) => {
          res.on("close", () => done());
          next();
        }),
    );
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
    // SW-700: undici (behind the client's fetch) drops a response with no headers, or a body
    // silent, for 300 s, and a grant can run 15 min. A client that asks gets headers now,
    // a space a minute, and the status in the body; any other client gets status codes.
    const streamed = req.headers[STREAM_HEADER] === "1";
    let beat: NodeJS.Timeout | undefined;
    if (streamed) {
      res.status(200).set({ "Content-Type": "application/json", [STREAM_HEADER]: "1" });
      res.flushHeaders();
      beat = setInterval(() => res.write(" "), HEARTBEAT_MS);
      res.on("close", () => clearInterval(beat));
    }
    const reply = (status: number, body: Record<string, unknown>) => {
      clearInterval(beat);
      if (streamed) res.end(JSON.stringify({ status, ...body }));
      else res.status(status).json(body);
    };
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
        reply(400, { error: textOf(result), code: code ?? "TOOL" });
        return;
      }
      reply(200, { structuredContent: result.structuredContent ?? null, text: textOf(result) });
    } catch (e) {
      reply(500, { error: (e as Error).message, code: "INTERNAL" });
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
  // that's where the failure has to be handled. Diagnostics go to stderr, as the
  // daemon's launchd log collects it.
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
  // Without this an old `main.js --stdio` launch would try to bind the daemon's port.
  if (process.argv.includes("--stdio")) {
    console.error(
      "[werkmeister-mcp] --stdio moved to the session proxy (SW-344): run `werkmeister internal mcp` " +
        "(dist/proxy.js).",
    );
    process.exit(1);
  }
  await startHttp();
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
