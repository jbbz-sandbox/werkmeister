/**
 * `werkmeister internal mcp` (SW-344): the stdio MCP server each Claude Code / Claude Desktop
 * session spawns, as a thin proxy to the host daemon's `/mcp`. Tool logic runs only in the
 * daemon, which restarts itself on a new build (SW-306), so a rebuild reaches running sessions:
 * a changed `X-Werkmeister-Build` here becomes `notifications/tools/list_changed`.
 *
 * A change to this file still needs every session to `/mcp` reconnect or restart: say so in
 * the release notes, and keep it small and rarely changed.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListResourcesRequestSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesRequestSchema,
  ListResourceTemplatesResultSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  ReadResourceRequestSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  BUILD_HEADER,
  CLIENT_UI_HEADER,
  DaemonUnavailable,
  daemonStatus,
  daemonToken,
  daemonUrl,
  LAUNCHER_HEADER,
} from "werkmeister-core/daemon_client";
import { claudeLauncher } from "werkmeister-core/launcher";

/** apps/werkmeister-mcp/src/lib/feature.ts FEATURE_HEADER; not imported, it pulls in all of compose. */
const FEATURE_HEADER = "x-werkmeister-feature";
const UI_EXTENSION = "io.modelcontextprotocol/ui";
// Test knobs: the defaults cover launchd's restart of the daemon and an idle session's rebuild.
const RETRY_MS = Number(process.env.WERKMEISTER_PROXY_RETRY_MS) || 30_000;
const POLL_MS = Number(process.env.WERKMEISTER_PROXY_POLL_MS) || 15_000;
const CALL_TIMEOUT_MS = 15 * 60_000; // as the daemon's /api/tool: `up` and close-out run long

const log = (msg: string) => console.error(`[werkmeister-mcp-proxy] ${msg}`);

/** The dir name of the workspace holding *dir*, which the daemon resolves first. */
function workspaceOf(dir: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".werkmeister", "workspace.yml"))) return path.basename(d);
    if (path.dirname(d) === d) return undefined;
  }
}

export async function runProxy(): Promise<void> {
  const workspace = workspaceOf(process.cwd());
  const launcher = claudeLauncher(process.env);
  const token = daemonToken();
  let clientUi: string[] = [];
  let build: string | null = null;
  let down = false;

  const server = new Server(
    { name: "werkmeister", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true }, resources: {} } },
  );
  server.oninitialized = () => {
    const ext = (server.getClientCapabilities() as { extensions?: Record<string, unknown> })
      ?.extensions?.[UI_EXTENSION] as { mimeTypes?: string[] } | undefined;
    clientUi = ext?.mimeTypes ?? [];
  };

  const listChanged = () => server.sendToolListChanged().catch(() => {});
  const seeBuild = (seen: string | null) => {
    if (!seen) return;
    if (build !== null && seen !== build) {
      log(`daemon build changed (${build} → ${seen}): tools/list_changed`);
      void listChanged();
    }
    build = seen;
  };

  // The daemon's /mcp is stateless, so a notifications/cancelled reaches a server that never saw
  // the call. Closing the call's own HTTP request is what aborts it there (main.ts, /mcp).
  const callSignal = new AsyncLocalStorage<AbortSignal>();

  const daemonFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (workspace) headers.set(FEATURE_HEADER, workspace);
    headers.set(LAUNCHER_HEADER, launcher);
    if (clientUi.length) headers.set(CLIENT_UI_HEADER, clientUi.join(","));
    const deadline = Date.now() + RETRY_MS;
    for (;;) {
      try {
        const cancel = callSignal.getStore();
        const signal =
          cancel && init?.signal ? AbortSignal.any([init.signal, cancel]) : init?.signal;
        const res = await fetch(url, { ...init, headers, signal: signal ?? cancel });
        seeBuild(res.headers.get(BUILD_HEADER));
        return res;
      } catch (e) {
        // Only a refused connection is safe to resend: the request never reached the daemon.
        const code = (e as { cause?: { code?: string } }).cause?.code;
        if (code !== "ECONNREFUSED") throw e;
        if (Date.now() >= deadline) {
          down = true;
          throw new DaemonUnavailable(code);
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };

  let upstream: Promise<Client> | null = null;
  const daemon = (): Promise<Client> => {
    if (!upstream) {
      const client = new Client({ name: "werkmeister-proxy", version: "0.1.0" });
      upstream = client
        .connect(
          new StreamableHTTPClientTransport(new URL(`${daemonUrl()}/mcp`), { fetch: daemonFetch }),
        )
        .then(() => client);
      // A failed connect is retried on the next request; the daemon's /mcp is stateless,
      // so a connected client survives the daemon's restarts.
      upstream.catch(() => {
        upstream = null;
      });
    }
    return upstream;
  };

  const forward = async <T>(
    method: string,
    params: unknown,
    schema: Parameters<Client["request"]>[1],
    opts?: { signal?: AbortSignal; timeout?: number },
  ): Promise<T> => {
    const result = await (await daemon()).request({ method, params } as never, schema, opts);
    down = false;
    return result as T;
  };
  const message = (e: unknown) => {
    if (e instanceof DaemonUnavailable) return e.message;
    // fetch's own message is only "fetch failed"; the reason is in its cause.
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const why = cause ? ` (${cause.code ?? cause.message})` : "";
    return `werkmeister daemon: ${(e as Error).message}${why}`;
  };

  server.setRequestHandler(ListToolsRequestSchema, async (req) => {
    try {
      return await forward("tools/list", req.params, ListToolsResultSchema);
    } catch (e) {
      // An empty list, not an error: the poll below sends list_changed once the daemon answers.
      log(message(e));
      return { tools: [] };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    try {
      return await callSignal.run(extra.signal, () =>
        forward("tools/call", req.params, CallToolResultSchema, {
          signal: extra.signal,
          timeout: CALL_TIMEOUT_MS,
        }),
      );
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: message(e) }] };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, (req) =>
    forward("resources/list", req.params, ListResourcesResultSchema),
  );
  server.setRequestHandler(ListResourceTemplatesRequestSchema, (req) =>
    forward("resources/templates/list", req.params, ListResourceTemplatesResultSchema),
  );
  server.setRequestHandler(ReadResourceRequestSchema, (req) =>
    forward("resources/read", req.params, ReadResourceResultSchema),
  );

  await server.connect(new StdioServerTransport());

  // An idle session learns of a rebuild, or of a daemon that came back, without making a call.
  setInterval(async () => {
    const status = await daemonStatus();
    if (status === null) {
      down = true;
      return;
    }
    if (down) {
      down = false;
      void listChanged();
    }
    seeBuild(status.loaded);
  }, POLL_MS).unref();
}

// realpath on both sides: the wrapper may reach this file through a symlink.
const isEntry =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isEntry) {
  runProxy().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
