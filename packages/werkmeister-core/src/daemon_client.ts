/**
 * The thin-client side of the host daemon (SW-184): the VS Code extension and the
 * CLI's SessionEnd stop call the daemon's `POST /api/tool` and
 * `GET /api/logs/stream` instead of touching Docker in their own process.
 * Built-in `fetch` only — this ships inside the extension bundle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { LogTail } from "./compose.js";
import { envVar, sandboxHome } from "./config.js";
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

/**
 * The base URL of the werkmeister daemon, with no trailing slash. Runs in-process and makes no
 * network call.
 *
 * @returns `WERKMEISTER_HOST` when it is set (e.g. `http://host.docker.internal:3002`), else the
 * loopback address `http://127.0.0.1:<port>`, where the port is `WERKMEISTER_MCP_PORT`, the
 * machine config's `mcp_port` override, or 3002.
 *
 * @example
 * ```ts
 * import { daemonUrl } from "werkmeister-core/sdk";
 *
 * const res = await fetch(`${daemonUrl()}/api/status`);
 * console.log(res.status);
 * ```
 */
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
    readToken(path.join(sandboxHome(), "mcp-token"))
  );
}

/**
 * Thrown when the werkmeister daemon is not reachable: nothing is listening at {@link daemonUrl},
 * or something other than the daemon holds its port. The daemon never saw the call, so it is safe
 * to run the work another way. Its `code` is `DAEMON_DOWN`, and it extends {@link SandboxError}.
 *
 * @example
 * ```ts
 * import { callTool, DaemonUnavailable } from "werkmeister-core/sdk";
 *
 * try {
 *   await callTool("status");
 * } catch (e) {
 *   if (e instanceof DaemonUnavailable)
 *     console.log(e.code, e.message); // "DAEMON_DOWN"
 *   else throw e;
 * }
 * ```
 */
export class DaemonUnavailable extends SandboxError {
  /** @param detail - Why the daemon could not be reached; it goes into the message. */
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

/** The daemon took the call but did not answer in time: it may still be running it, so never run it again here. */
export class DaemonTimeout extends SandboxError {
  constructor(detail: string) {
    super(
      `werkmeister daemon at ${daemonUrl()} took the call but did not answer in time (${detail}); ` +
        "it may still be running it.",
      "DAEMON_TIMEOUT",
    );
  }
}

const NOT_LISTENING: Record<string, string> = {
  ECONNREFUSED: "ECONNREFUSED: nothing is listening, the daemon is not running",
  ECONNRESET: "ECONNRESET: the daemon reset the connection while exiting or restarting",
};

// launchd waits up to 10 s to respawn a daemon that ran under 10 s, then it boots in ~1-2 s (SW-614).
const restartGapMs = () => Number(envVar("DAEMON_RETRY_MS")) || 15_000;
// Once a wait gave up, the daemon is down, not restarting: later calls in this process try once.
let gaveUp = false;

/** The error *code* comes after the request reached the daemon; a connect timeout never got there. */
export const tookTheCall = (code: string) =>
  code === "TimeoutError" || (code.startsWith("UND_ERR_") && code !== "UND_ERR_CONNECT_TIMEOUT");

// fetch wraps ECONNREFUSED and timeouts as a TypeError/AbortError with a cause.
const codeOf = (e: unknown) => {
  const err = e as Error & { cause?: { code?: string } };
  return err.cause?.code ?? err.name;
};

/**
 * *retry*: wait out the daemon's own restart (SW-306) on a refused or reset connect,
 * which the daemon never saw, so resending is safe.
 */
async function send(url: string, init: RequestInit, retry = true): Promise<Response> {
  const deadline = Date.now() + (gaveUp ? 0 : restartGapMs());
  for (;;) {
    try {
      const res = await fetch(url, init);
      if (retry) gaveUp = false;
      return res;
    } catch (e) {
      const code = codeOf(e);
      if (tookTheCall(code)) throw new DaemonTimeout(code);
      if (!(code in NOT_LISTENING)) throw new DaemonUnavailable(code);
      if (!retry || Date.now() >= deadline) {
        if (retry) gaveUp = true;
        throw new DaemonUnavailable(NOT_LISTENING[code]);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Request: the build the CLI would start. Response: the build the daemon loaded (SW-306). */
export const BUILD_HEADER = "x-werkmeister-build";

/**
 * `/api/tool`, request `1`: answer with headers at once and the status in the body (SW-700).
 * Response `1`: the daemon did; a daemon that leaves it out answers with status codes.
 */
export const STREAM_HEADER = "x-werkmeister-stream";

// Set by the session's stdio proxy (SW-344): facts only the session's own process can see.
/** `claudeLauncher()` evaluated in the session's env, not the daemon's launchd env. */
export const LAUNCHER_HEADER = "x-werkmeister-launcher";
/** Comma-separated `io.modelcontextprotocol/ui` mime types the session's MCP client advertised. */
export const CLIENT_UI_HEADER = "x-werkmeister-client-ui";

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

// The header is a hint: a lookup that throws (no checkout to find, SW-718) sends none rather than dropping the call.
function buildToSend(): string | null {
  try {
    return expectedBuild?.() ?? null;
  } catch {
    return null;
  }
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

/**
 * What the werkmeister daemon reports about itself: its process, which build it runs and how
 * busy it is. {@link daemonStatus} returns it.
 *
 * @example
 * ```ts
 * import { daemonStatus, type DaemonStatus } from "werkmeister-core/sdk";
 *
 * const status: DaemonStatus | null = await daemonStatus();
 * if (status?.stale)
 *   console.log(`daemon ${status.pid} runs ${status.loaded}, disk has ${status.onDisk}`);
 * ```
 */
export interface DaemonStatus {
  /** The daemon's process id. */
  pid: number;
  /** Build id of the code the daemon loaded, or null when unknown. */
  loaded: string | null;
  /** Build id of the code on disk now, or null when unknown. */
  onDisk: string | null;
  /** True when `loaded` and `onDisk` differ: the daemon runs older code. */
  stale: boolean;
  /** Tool calls running now. */
  inFlight: number;
  /** Features waiting in the scheduler queue. */
  queued: number;
  /** True when the daemon is stale and will restart itself once idle. */
  restartPending: boolean;
}

/**
 * Asks the werkmeister daemon for its status. Needs the daemon, but never throws: it waits at
 * most 5 seconds and does not retry.
 *
 * @returns The daemon's {@link DaemonStatus}, or null when the daemon is down, does not answer
 * within 5 seconds, or refuses the request (for example a bad token).
 *
 * @example
 * ```ts
 * import { daemonStatus } from "werkmeister-core/sdk";
 *
 * const status = await daemonStatus();
 * if (!status) console.log("daemon is down: run the work in-process instead");
 * else console.log(`${status.inFlight} calls running, ${status.queued} queued`);
 * ```
 */
export async function daemonStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await send(
      `${daemonUrl()}/api/status`,
      { headers: headers(undefined), signal: AbortSignal.timeout(5000) },
      false,
    );
    return res.ok ? ((await res.json()) as DaemonStatus) : null;
  } catch {
    return null;
  }
}

/**
 * A daemon tool's answer, as {@link callTool} returns it: the structured result and the text an
 * MCP client would show.
 *
 * @example
 * ```ts
 * import { callTool, type ToolResult } from "werkmeister-core/sdk";
 *
 * type Listing = { workspaces: unknown[] };
 * const result: ToolResult<Listing> = await callTool<Listing>("list-workspaces");
 * console.log(result.text);
 * ```
 */
export interface ToolResult<T> {
  /** The tool's structured result; `T` is the caller's assertion, not checked. */
  data: T;
  /** The tool's text result, as an MCP client would show it. */
  text: string;
}

/**
 * Runs one werkmeister tool (the same tools the MCP server offers) in the werkmeister daemon and
 * returns its answer. Needs the daemon. If the daemon refuses or resets the connection, it waits
 * up to 15 seconds for a restarting daemon before giving up. Once a wait has given up, later calls
 * in the same process do not wait again until one gets through.
 *
 * @param name - The tool name, e.g. `"status"` or `"list-workspaces"`.
 * @param args - The tool's arguments. Defaults to none.
 * @param opts - `token`: the bearer token to send; by default `WERKMEISTER_MCP_TOKEN`, else the
 * machine token; `null` sends none. `signal`: aborts the call. `timeoutMs`: how long to wait for
 * the answer, in milliseconds; defaults to 120000.
 * @returns The tool's {@link ToolResult}. `T` is your assertion about `data`; it is not checked.
 * @throws {@link DaemonUnavailable} when the daemon is not running or something else holds its
 * port: the daemon never ran the tool, so you may run the work another way. Also when *signal*
 * aborts the call before any answer came back; the daemon may already be running the tool then.
 * @throws {@link SandboxError} when the daemon took the call but did not answer in time
 * (`code` `DAEMON_TIMEOUT`): it may still be running the tool, so do not run it again. Also when
 * the tool fails (the tool's own `code`, or `HTTP_<status>`), and when the daemon runs older code
 * that has no such tool (`DAEMON_STALE`).
 *
 * @example
 * ```ts
 * import { callTool, DaemonUnavailable } from "werkmeister-core/sdk";
 *
 * try {
 *   const { text } = await callTool("status", {}, { timeoutMs: 30_000 });
 *   console.log(text);
 * } catch (e) {
 *   if (!(e instanceof DaemonUnavailable)) throw e;
 *   console.log(e.message); // says how to start the daemon on this platform
 * }
 * ```
 */
export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  opts: { token?: string | null; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ToolResult<T>> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const build = buildToSend();
  const res = await send(`${daemonUrl()}/api/tool`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers(opts.token),
      ...(build ? { [BUILD_HEADER]: build } : {}),
      [STREAM_HEADER]: "1",
    },
    body: JSON.stringify({ name, arguments: args }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  checkBuild(build, res);
  // The daemon answers every /api/tool call in JSON, bar its empty 401/403 for a bad token or Origin.
  if (
    !res.headers.get("content-type")?.includes("json") &&
    res.status !== 401 &&
    res.status !== 403
  ) {
    throw new DaemonUnavailable(
      `HTTP ${res.status}: the port is held by something that is not the werkmeister daemon`,
    );
  }
  const streamed = res.headers.get(STREAM_HEADER) === "1";
  const body = (await res.json().catch((e) => {
    // Streamed headers mean the daemon is running the call: never let a caller run it again.
    if (streamed) throw new DaemonTimeout(codeOf(e));
    return {};
  })) as {
    status?: number;
    structuredContent?: T;
    text?: string;
    error?: string;
    code?: string;
  };
  const status = streamed ? (body.status ?? 500) : res.status;
  if (status < 200 || status > 299) {
    // SW-254: the daemon has no tool this CLI knows, so it runs older code; the MCP SDK's own words.
    if (body.error?.replace(/^MCP error -?\d+: /, "") === `Tool ${name} not found`) {
      throw new SandboxError(
        `The werkmeister daemon is older than this CLI: it has no \`${name}\` tool. ` +
          "Run `werkmeister daemon restart`.",
        "DAEMON_STALE",
      );
    }
    throw new SandboxError(
      body.error ?? `daemon answered HTTP ${status} to ${name}`,
      body.code ?? `HTTP_${status}`,
    );
  }
  return { data: body.structuredContent as T, text: body.text ?? "" };
}

/**
 * Follows a workspace's container logs and passes each chunk to *onData* as it arrives. Needs the
 * daemon. It returns at once; failures, including a daemon that is down, reject the returned
 * `done` promise instead of throwing.
 *
 * @param workspace - The workspace's name.
 * @param service - One service to follow, or null for all of the workspace's services.
 * @param onData - Called with each chunk of log text.
 * @param opts - `token`: the bearer token to send; by default `WERKMEISTER_MCP_TOKEN`, else the
 * machine token; `null` sends none.
 * @returns A {@link LogTail}. `done` resolves when the stream ends or you call `stop()`. It
 * rejects with {@link DaemonUnavailable} when the daemon is down, and with {@link SandboxError}
 * when the daemon refuses the stream or the logs fail.
 *
 * @example
 * ```ts
 * import { DaemonUnavailable, streamLogs } from "werkmeister-core/sdk";
 *
 * const tail = streamLogs("my-workspace", null, (chunk) => process.stdout.write(chunk));
 * setTimeout(() => tail.stop(), 10_000);
 * await tail.done.catch((e) => {
 *   if (e instanceof DaemonUnavailable) console.log("daemon is down: try `werkmeister feature logs`");
 *   else throw e;
 * });
 * ```
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
