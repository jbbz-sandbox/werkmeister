/**
 * Lifecycle for the sandbox-workspace MCP web server (apps/sandbox-dashboard).
 *
 * This runs as a plain host `node` process — NOT a container — because its tools
 * drive host-local things (Docker, VS Code, Terminal, kubectl, the `sandbox` and
 * `claude` CLIs) that a container can't reach. `sandbox connect` builds and starts
 * it alongside the shared-infra containers; `sandbox down/stop/restart infra`
 * tears it down or bounces it; `sandbox status` reports it.
 *
 * Tracked by a PID file under `~/.sandbox/` (same state dir as the slot locks).
 * Serves the MCP endpoint at `/mcp` and the workspaces dashboard at `/`.
 *
 * The port is fixed at {@link PORT} (3001) — NOT configurable. A floating port
 * (read from the launching shell's env) let the dashboard land on a different port
 * per invocation, which orphaned the previous server: the PID file tracks a single
 * pid, so a server left on an old port became untracked and unreapable. Pinning the
 * port plus `freePort` (reap whatever holds the port before binding) keeps
 * it to exactly one server on one known URL.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { error, getSandboxRoot, info, success, warn } from "./config.js";
import { ProcError, run } from "./proc.js";

export const PORT = 3001;

function portNum(): number {
  return PORT;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Kill whatever is listening on *port* (SIGTERM, then SIGKILL) so a start
 * always binds cleanly. Reaps a stale/orphaned dashboard the PID file lost
 * track of. Best-effort: no-op if lsof is missing or the port is free.
 */
async function freePort(port: number): Promise<void> {
  let out: string;
  try {
    out = run(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
      capture: true,
      timeout: 5,
    }).stdout;
  } catch (err) {
    if (err instanceof ProcError && (err.code === "ENOENT" || err.code === "ETIMEDOUT")) {
      return;
    }
    throw err;
  }
  const pids = out
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p))
    .map((p) => Number.parseInt(p, 10));
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
  if (pids.length === 0) {
    return;
  }
  for (let i = 0; i < 20; i++) {
    if (!(await portOpen(port))) {
      return;
    }
    await sleep(0.25);
  }
  for (const pid of pids) {
    // still bound → force it
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

function stateDir(): string {
  const d = path.join(os.homedir(), ".sandbox");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function pidFile(): string {
  return path.join(stateDir(), "mcp-server.pid");
}

function logFile(): string {
  return path.join(stateDir(), "mcp-server.log");
}

function mcpDir(): string {
  return path.join(getSandboxRoot(), "apps", "sandbox-dashboard");
}

/** Match one of the fixed one-level glob patterns below (Python Path.glob subset). */
function globMatch(dir: string, pattern: string): string[] {
  const idx = pattern.lastIndexOf("/");
  const base = idx >= 0 ? path.join(dir, pattern.slice(0, idx)) : dir;
  const filePat = idx >= 0 ? pattern.slice(idx + 1) : pattern;
  const re = new RegExp(
    "^" +
      filePat
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  );
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => re.test(e.name)).map((e) => path.join(base, e.name));
}

/**
 * True if the build is missing or any source file is newer than it.
 *
 * `dist/main.js` is the reference: `npm run build` regenerates it (tsc) after
 * the UI bundles, so it's the newest artifact after a successful build. Any
 * source edit afterwards makes that source newer → stale.
 */
function distStale(): boolean {
  const dir = mcpDir();
  const ref = path.join(dir, "dist", "main.js");
  let refMtime: number;
  try {
    const st = fs.statSync(ref);
    if (!st.isFile()) {
      return true;
    }
    refMtime = st.mtimeMs;
  } catch {
    return true;
  }
  // Everything that feeds `npm run build` (node_modules/dist excluded).
  const patterns = ["*.ts", "*.html", "package.json", "tsconfig*.json",
                    "lib/*.ts", "src/*.ts", "src/*.css"];
  for (const pat of patterns) {
    for (const f of globMatch(dir, pat)) {
      try {
        if (fs.statSync(f).mtimeMs > refMtime) {
          return true;
        }
      } catch {
        continue;
      }
    }
  }
  return false;
}

/**
 * True if the build was refreshed after the current server was launched.
 *
 * `start()` rewrites the PID file on every launch, so its mtime marks when the
 * live process began. A direct `npm run build` (outside `sandbox connect`)
 * updates `dist/` without bouncing the server, leaving it serving a stale
 * bundle — this catches that: `dist/main.js` newer than the PID file means the
 * running process predates the build. Best-effort: unknown → false (don't
 * bounce a healthy server on a stat error).
 */
function buildNewerThanRunning(): boolean {
  const ref = path.join(mcpDir(), "dist", "main.js");
  try {
    return fs.statSync(ref).mtimeMs > fs.statSync(pidFile()).mtimeMs;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  let text: string;
  try {
    text = fs.readFileSync(pidFile(), "utf8");
  } catch {
    return null;
  }
  const s = text.trim();
  if (!/^[+-]?\d+$/.test(s)) {
    return null;
  }
  return Number.parseInt(s, 10);
}

/** True if a process with *pid* exists (signal 0 probe). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    if (code === "EPERM") {
      return true; // exists but owned by another user
    }
    throw err;
  }
  return true;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** [running, pid] from the PID file, verified against the live process. */
export function isRunning(): [boolean, number | null] {
  const pid = readPid();
  if (pid && alive(pid)) {
    return [true, pid];
  }
  return [false, null];
}

export interface McpServerStatus {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
  healthy: boolean;
}

/** Snapshot for `sandbox status` (and its --json). */
export async function status(): Promise<McpServerStatus> {
  const [running, pid] = isRunning();
  const port = portNum();
  return {
    running,
    pid,
    port,
    url: `http://localhost:${port}/`,
    healthy: running && (await portOpen(port)),
  };
}

/**
 * Build (optional) and start the MCP web server.
 *
 * Non-fatal: on any failure it warns and returns false so `sandbox connect`
 * still finishes bringing up the infra. With `force` it rebuilds and bounces
 * an already-running server (so `sandbox connect` picks up code changes);
 * without it, an already-running server is left as-is.
 */
export async function start(build = true, force = false): Promise<boolean> {
  const [running, pid] = isRunning();

  const dir = mcpDir();
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    warn(`MCP app not found at ${dir}; skipping web server`);
    return false;
  }

  let rebuilt = false;
  if (build && distStale()) {
    info("Building MCP web server (sources changed)...");
    let result;
    try {
      result = run(["npm", "run", "build"], { cwd: dir, capture: true, timeout: 300 });
    } catch (err) {
      if (err instanceof ProcError && err.code === "ENOENT") {
        warn("npm not found; skipping MCP web server");
        return false;
      }
      if (err instanceof ProcError && err.code === "ETIMEDOUT") {
        error("MCP web server build timed out; skipping");
        return false;
      }
      throw err;
    }
    if (result.status !== 0) {
      // Build failed — leave any running server untouched.
      const detail = (result.stderr.trim() || result.stdout.trim()).slice(-800);
      error(`MCP web server build failed; skipping start:\n${detail}`);
      return false;
    }
    rebuilt = true;
  } else if (build) {
    info("MCP web server build up to date; skipping build");
  }

  // A direct `npm run build` can refresh dist without bouncing the server,
  // leaving it serving a stale bundle. Treat that like an explicit force so the
  // bounce path below reloads it.
  if (running && !rebuilt && buildNewerThanRunning()) {
    info("Running dashboard predates the current build; bouncing to reload it.");
    force = true;
  }

  // Already running with nothing new to load → leave it as-is.
  if (running && !rebuilt && !force) {
    success(`MCP web server already running (pid ${pid}, http://localhost:${portNum()}/)`);
    return true;
  }

  // Bounce a running instance to pick up a rebuild (or a forced restart).
  if (running) {
    await stop();
  }

  const port = portNum();
  // Reap anything still holding the port — a server the PID file lost track of
  // (e.g. one left on this port by an older, floating-port launch), so the
  // start below always binds cleanly and we never leak a second dashboard.
  await freePort(port);
  const log = logFile();
  const env = { ...process.env, PORT: String(port) };
  info(`Starting MCP web server on http://localhost:${port}/ ...`);
  // Detached (own session) so it outlives this CLI invocation; logs to a
  // fresh file each start to stay bounded.
  const logFd = fs.openSync(log, "w");
  const child = spawn("node", ["dist/main.js"], {
    cwd: dir,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env,
  });
  const spawnResult = await new Promise<"spawned" | Error>((resolve) => {
    child.once("spawn", () => resolve("spawned"));
    child.once("error", (e) => resolve(e));
  });
  fs.closeSync(logFd);
  if (spawnResult !== "spawned") {
    if ((spawnResult as NodeJS.ErrnoException).code === "ENOENT") {
      warn("node not found; skipping MCP web server");
      return false;
    }
    throw spawnResult;
  }
  child.unref();

  fs.writeFileSync(pidFile(), String(child.pid));

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  // Give it a moment to bind (or die) before reporting.
  for (let i = 0; i < 20; i++) {
    if (exited) {
      error(`MCP web server exited immediately (see ${log})`);
      fs.rmSync(pidFile(), { force: true });
      return false;
    }
    if (await portOpen(port)) {
      success(`MCP web server started (pid ${child.pid}, http://localhost:${port}/)`);
      return true;
    }
    await sleep(0.25);
  }

  warn(`MCP web server started (pid ${child.pid}) but port ${port} not up yet; check ${log}`);
  return true;
}

/** Stop the MCP web server (SIGTERM, then SIGKILL). Returns true if it was running. */
export async function stop(): Promise<boolean> {
  const [running, pid] = isRunning();
  if (!running || pid === null) {
    fs.rmSync(pidFile(), { force: true });
    return false;
  }

  info(`Stopping MCP web server (pid ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      fs.rmSync(pidFile(), { force: true });
      return false;
    }
    if (code === "EPERM") {
      error(`Cannot signal pid ${pid} (owned by another user)`);
      return false;
    }
    throw err;
  }

  let dead = false;
  for (let i = 0; i < 20; i++) {
    if (!alive(pid)) {
      dead = true;
      break;
    }
    await sleep(0.25);
  }
  if (!dead) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  fs.rmSync(pidFile(), { force: true });
  // Reap a rogue holder of the port too, in case the PID file had drifted off
  // the process actually bound to it.
  await freePort(portNum());
  success("MCP web server stopped");
  return true;
}

/** Bounce the server (no rebuild by default — mirrors `docker compose restart`). */
export async function restart(build = false): Promise<void> {
  await start(build, true);
}
