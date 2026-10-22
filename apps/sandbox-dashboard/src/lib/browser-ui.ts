/**
 * Browser-accessible fallback for the inline "Sandbox Workspaces" MCP App UI.
 *
 * The dashboard (`src/workspace-ui.ts`) renders inline in Claude Desktop and as
 * a Cowork artifact. Hosts that don't render `ui://` resources (Claude Code
 * CLI, the VS Code extension) can't show it — so this serves the SAME bundled
 * UI (`dist/browser.html`) as an ordinary web page and proxies its tool calls
 * back into the real MCP tool handlers over an in-memory transport. No dispatch
 * table to keep in sync: the browser talks to the exact tools every other host
 * does, via a `Client` linked to apps/mcp's `createServer()`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express, { type Router } from "express";
import { createServer } from "werkmeister-mcp";
import { localOnly } from "./localhost-form.js";
import { subscribeSession } from "./session-stream.js";

// Works both from source (src/lib/browser-ui.ts via tsx) and compiled
// (dist/lib/browser-ui.js) — the built UI always lives at dist/browser.html.
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "..", "dist")
  : path.join(import.meta.dirname, "..");

/** A fresh MCP server + client linked in-process; the client advertises no UI
 *  capability, so tools take their non-UI path and return `structuredContent`. */
async function connectInMemoryClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  const client = new Client({ name: "workspaces-browser", version: "0.1.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const part = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  return part?.text ?? "Tool call failed.";
}

// Trust boundary: `/api/*` dispatches into host-level MCP tools (Docker, VS
// Code, kubectl, `claude`, workspace create/remove) with NO authentication —
// the shared `localOnly` guard (lib/localhost-form.ts) refuses cross-origin
// and non-localhost requests.

/**
 * Express router serving the dashboard at `GET /` and dispatching tool calls at
 * `POST /api/tool`. Mount at the app root (not a sub-path) so the page's
 * same-origin `fetch("/api/tool")` resolves.
 */
export async function createBrowserUiRouter(): Promise<Router> {
  const client = await connectInMemoryClient();
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/", async (_req, res) => {
    try {
      const html = await fs.readFile(path.join(DIST_DIR, "browser.html"), "utf-8");
      res.type("html").send(html);
    } catch {
      res
        .status(500)
        .type("text")
        .send("Browser UI bundle missing — run `pnpm run build` in apps/sandbox-dashboard.");
    }
  });

  // Live session stream (SSE) — the browser surface's replacement for
  // claude-transcript polling. Server→client only; sends still go through
  // POST /api/tool (claude-send). No new dependency; EventSource gives
  // auto-reconnect + Last-Event-ID for free. Only this same-origin Express
  // surface can hold the socket — the Desktop-inline and Cowork-artifact
  // surfaces keep polling (they leave HostBridge.streamSession undefined).
  router.get("/api/session/stream", localOnly, (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : "";
    if (!name) {
      res.status(400).end();
      return;
    }
    // Resume cursor: an explicit `from` query param (client tracks its
    // last-seen index across manual reconnects — EventSource can't set the
    // Last-Event-ID header) wins; otherwise the auto-reconnect Last-Event-ID
    // (last-delivered index + 1), re-sent one earlier so a mid-growth last
    // message refreshes on reconnect (index adds are idempotent upserts).
    const fromQ =
      typeof req.query.from === "string" ? Number.parseInt(req.query.from, 10) : Number.NaN;
    const lastId = Number(req.headers["last-event-id"] ?? 0) || 0;
    const fromIndex = Number.isFinite(fromQ) && fromQ >= 0 ? fromQ : Math.max(0, lastId - 1);
    // Pin to a specific session (chat panel's picker); absent → follow newest.
    const sessionId = typeof req.query.session === "string" ? req.query.session : undefined;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();
    const unsub = subscribeSession(
      name,
      (e) => {
        if (e.type === "entry") res.write(`id: ${e.index + 1}\n`);
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      },
      fromIndex,
      sessionId,
    );
    req.on("close", unsub);
  });

  router.post("/api/tool", localOnly, async (req, res) => {
    const { name, arguments: args } = (req.body ?? {}) as {
      name?: string;
      arguments?: Record<string, unknown>;
    };
    if (!name) {
      res.status(400).json({ error: "missing tool name" });
      return;
    }
    try {
      const result = (await client.callTool({ name, arguments: args ?? {} })) as CallToolResult;
      if (result.isError) {
        res.status(400).json({ error: textOf(result) });
        return;
      }
      res.json({
        structuredContent: result.structuredContent ?? null,
        content: result.content ?? [],
      });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  return router;
}
