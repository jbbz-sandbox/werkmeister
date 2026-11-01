/**
 * The thin-client side of the host daemon (SW-184): the VS Code extension and the
 * CLI's SessionEnd stop call the daemon's `POST /api/tool` and
 * `GET /api/logs/stream` instead of touching Docker in their own process.
 * Built-in `fetch` only — this ships inside the extension bundle.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { LogTail } from "./compose.js";
import { envVar } from "./config.js";
import { dotDir } from "./dot_dir.js";
import { SandboxError } from "./errors.js";
import { load } from "./global_config.js";
import { warn } from "./reporter.js";
import { workspaceTokenFile } from "./workspace_token.js";

export const DEFAULT_DAEMON_PORT = 3002;

export function daemonPort(): number {
  const raw = envVar("MCP_PORT") || load()["overrides"]?.["mcp_port"];
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_DAEMON_PORT;
}

/** `WERKMEISTER_HOST` (proposal §2.4; e.g. http://host.docker.internal:3002), else loopback. */
export function daemonUrl(): string {
  return (envVar("HOST") || `http://127.0.0.1:${daemonPort()}`).replace(/\/+$/, "");
}

function readToken(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** WERKMEISTER_MCP_TOKEN, else the workspace's own token, else the machine token. */
export function daemonToken(workspaceRoot?: string): string | null {
  return (
    envVar("MCP_TOKEN") ||
    (workspaceRoot ? readToken(workspaceTokenFile(workspaceRoot)) : null) ||
    readToken(path.join(dotDir(os.homedir()), "mcp-token"))
  );
}

/** The daemon is not listening (or did not answer in time): the caller may fall back. */
export class DaemonUnavailable extends SandboxError {
  constructor(detail: string) {
    super(
      `werkmeister daemon not reachable at ${daemonUrl()} (${detail}). ` +
        "Run `werkmeister machine setup` (macOS) or `werkmeister infra connect`.",
      "DAEMON_DOWN",
    );
  }
}

function headers(token: string | null | undefined): Record<string, string> {
  const t = token === undefined ? daemonToken() : token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    // fetch wraps ECONNREFUSED and timeouts as a TypeError/AbortError with a cause.
    const err = e as Error & { cause?: { code?: string } };
    throw new DaemonUnavailable(err.cause?.code ?? err.name);
  }
}

/** Request: the build the CLI would start. Response: the build the daemon loaded (SW-306). */
export const BUILD_HEADER = "x-werkmeister-build";

/**
 * `<version> @ <mtime>` of a daemon entry, or null when unreadable. Both parts:
 * a dev-link rebuild moves only the mtime, while npm extracts every release with
 * one fixed mtime, so a release moves only the version.
 */
export function buildOf(entry: string | undefined): string | null {
  if (!entry) return null;
  try {
    const mtime = fs
      .statSync(entry)
      .mtime.toISOString()
      .replace(/\.\d+Z$/, "Z");
    for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
      const pkg = path.join(dir, "package.json");
      if (fs.existsSync(pkg))
        return `${JSON.parse(fs.readFileSync(pkg, "utf8")).version} @ ${mtime}`;
      if (path.dirname(dir) === dir) return null;
    }
  } catch {
    return null;
  }
}

// Set only by the CLI: the VS Code extension bundles this module and must neither stat nor print.
let expectedBuild: (() => string | null) | null = null;
let staleWarned = false;

/** Send *get*'s build with each call and warn once when the daemon loaded another. */
export function expectDaemonBuild(get: () => string | null): void {
  expectedBuild = get;
}

function checkBuild(onDisk: string | null, res: Response): void {
  const loaded = res.headers.get(BUILD_HEADER);
  if (staleWarned || !onDisk || !loaded || loaded === onDisk) return;
  staleWarned = true;
  warn(
    `The werkmeister daemon runs an older build (loaded ${loaded}, on disk ${onDisk}); ` +
      "it restarts by itself once idle, or run `werkmeister daemon restart`.",
  );
}

export interface DaemonStatus {
  pid: number;
  loaded: string | null;
  onDisk: string | null;
  stale: boolean;
  inFlight: number;
  queued: number;
  restartPending: boolean;
}

/** The daemon's own `GET /api/status`, or null when it is down or refuses. */
export async function daemonStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await send(`${daemonUrl()}/api/status`, {
      headers: headers(undefined),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok ? ((await res.json()) as DaemonStatus) : null;
  } catch {
    return null;
  }
}

export interface ToolResult<T> {
  data: T;
  text: string;
}

export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  opts: { token?: string | null; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolResult<T>> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const build = expectedBuild?.() ?? null;
  const res = await send(`${daemonUrl()}/api/tool`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers(opts.token),
      ...(build ? { [BUILD_HEADER]: build } : {}),
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  checkBuild(build, res);
  const body = (await res.json().catch(() => ({}))) as {
    structuredContent?: T;
    text?: string;
    error?: string;
    code?: string;
  };
  if (!res.ok) {
    // SW-254: the daemon has no tool this CLI knows, so it runs older code; the MCP SDK's own words.
    if (body.error?.replace(/^MCP error -?\d+: /, "") === `Tool ${name} not found`) {
      throw new SandboxError(
        `The werkmeister daemon is older than this CLI: it has no \`${name}\` tool. ` +
          "Run `werkmeister daemon restart`.",
        "DAEMON_STALE",
      );
    }
    throw new SandboxError(
      body.error ?? `daemon answered HTTP ${res.status} to ${name}`,
      body.code ?? `HTTP_${res.status}`,
    );
  }
  return { data: body.structuredContent as T, text: body.text ?? "" };
}

/**
 * Follow a workspace's logs over the daemon's SSE endpoint, in the same
 * {@link LogTail} shape as core's in-process `composeLogsStream`.
 */
export function streamLogs(
  workspace: string,
  service: string | null,
  onData: (chunk: string) => void,
  opts: { token?: string | null } = {},
): LogTail {
  const abort = new AbortController();
  const query = new URLSearchParams({ feature: workspace, ...(service ? { service } : {}) });
  const done = (async () => {
    const res = await send(`${daemonUrl()}/api/logs/stream?${query}`, {
      headers: headers(opts.token),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      throw new SandboxError(`log stream refused: HTTP ${res.status}`, `HTTP_${res.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const bytes of res.body) {
      buffer += decoder.decode(bytes as Uint8Array, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const event = parseEvent(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event.name === "end") return;
        if (event.name === "error")
          throw new SandboxError(JSON.parse(event.data) as string, "LOGS");
        onData(JSON.parse(event.data) as string);
        end = buffer.indexOf("\n\n");
      }
    }
  })().catch((e: Error) => {
    if (abort.signal.aborted) return;
    throw e;
  });
  return { stop: () => abort.abort(), done };
}

function parseEvent(block: string): { name: string; data: string } {
  let name = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) name = line.slice(7);
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  return { name, data: data.join("\n") };
}
