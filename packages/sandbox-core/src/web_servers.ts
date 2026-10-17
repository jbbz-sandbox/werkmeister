/**
 * Lifecycle for the sandbox's host web servers — the workspaces dashboard /
 * MCP app (apps/sandbox-dashboard) and the remote MCP surface (apps/mcp).
 *
 * All run as plain host `node` processes — NOT containers — because their
 * tools drive host-local things (Docker, VS Code, Terminal, kubectl, the
 * `sandbox` and `claude` CLIs) that a container can't reach. `sandbox connect`
 * builds and starts them alongside the shared-infra containers; `sandbox
 * down/stop/restart infra` tears them down or bounces them; `sandbox status`
 * reports the dashboard.
 *
 * Each is tracked by a PID file under `~/.sandbox/` (same state dir as the slot
 * locks), keyed by {@link WebApp.stem}.
 *
 * Ports are fixed per app — NOT configurable. A floating port (read from the
 * launching shell's env) let a server land on a different port per invocation,
 * which orphaned the previous one: the PID file tracks a single pid, so a server
 * left on an old port became untracked and unreapable. Pinning the port plus
 * `freePort` (reap whatever holds the port before binding) keeps it to exactly
 * one server per app on one known URL.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { monorepoRoot, sandboxRoot } from "./config.js";
import { ProcError, run } from "./proc.js";
import { error, info, success, warn } from "./reporter.js";

/** One managed host web server. */
export interface WebApp {
  /** Human label used in every message this module prints. */
  label: string;
  /** Directory name under `apps/`. */
  dir: string;
  /** Fixed listen port (see the module docstring for why it isn't configurable). */
  port: number;
  /** PID/log file stem under `~/.sandbox`. */
  stem: string;
  /** Entry script, relative to the app dir. */
  entry: string;
  /** Build artifact used as the staleness reference. */
  buildRef: string;
  /**
   * Prebuilt copy inside the CLI package, relative to `sandboxRoot()`. Used
   * when the sibling app dir is absent — an `npm i -g` install ships only
   * apps/cli, with this bundled in by its esbuild.mjs. Nothing to build there.
   */
  bundled?: string;
  /**
   * Extra environment variables for this app's process, merged over
   * `process.env` last (see `start()`). Per-app rather than inherited by
   * every managed app: `apps/mcp` is the one server a container must reach
   * over the network, so it alone needs a wide (`0.0.0.0`) bind. DASHBOARD
   * is host-only and unauthenticated — binding it to every interface would
   * expose unauthenticated tools to the network, so it must not inherit this.
   */
  env?: Record<string, string>;
}

export const DASHBOARD: WebApp = {
  label: "MCP web server",
  dir: "sandbox-dashboard",
  port: 3001,
  stem: "mcp-server",
  entry: "dist/main.js",
  buildRef: "dist/main.js",
};

/**
 * The remote MCP surface (`apps/mcp`) — the authenticated, headless sibling of
 * DASHBOARD. Its stem is `sandbox-mcp` and not `mcp-server`, which DASHBOARD
 * already holds: a shared stem means a shared PID file and two apps reaping
 * each other. Port 3002 is free — dashboard 3001, feature slots
 * from 11100 (`getPortRange`).
 */
export const MCP: WebApp = {
  label: "Sandbox MCP server",
  dir: "mcp",
  port: 3002,
  stem: "sandbox-mcp",
  entry: "dist/main.js",
  buildRef: "dist/main.js",
  bundled: "dist/mcp.js",
  // Must be reachable from a container with no Docker socket (that's the
  // whole point of this app), and a container's requests arrive over the
  // bridge network, not loopback — so this is the one managed app that
  // needs a wide bind. On a 0.0.0.0 bind, apps/mcp/src/lib/token.ts's
  // authorized() makes the bearer token mandatory (it only accepts a
  // missing header on loopback), so this does not open the surface up —
  // it just makes auth non-optional. DASHBOARD deliberately doesn't set
  // this: it's unauthenticated and must stay loopback-only.
  env: { HOST: "0.0.0.0" },
};

/** Every app `sandbox connect` brings up (and `down`/`stop`/`restart` manage). */
export const ALL: readonly WebApp[] = [DASHBOARD, MCP];

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Kill whatever is listening on *port* (SIGTERM, then SIGKILL) so a start
 * always binds cleanly. Reaps a stale/orphaned server the PID file lost
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

function pidFile(app: WebApp): string {
  return path.join(stateDir(), `${app.stem}.pid`);
}

function logFile(app: WebApp): string {
  return path.join(stateDir(), `${app.stem}.log`);
}

function appDir(app: WebApp): string {
  return path.join(monorepoRoot(), "apps", app.dir);
}

/** Match one of the fixed one-level glob patterns below. */
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
 * `buildRef` is the reference: `npm run build` regenerates it (tsc) after
 * the UI bundles, so it's the newest artifact after a successful build. Any
 * source edit afterwards makes that source newer → stale.
 */
function distStale(app: WebApp): boolean {
  const dir = appDir(app);
  const ref = path.join(dir, app.buildRef);
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
  const patterns = [
    "*.ts",
    "*.html",
    "package.json",
    "tsconfig*.json",
    "src/*.ts",
    "src/*.css",
    "src/lib/*.ts",
  ];
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
 * bundle — this catches that: the build artifact newer than the PID file means
 * the running process predates the build. Best-effort: unknown → false (don't
 * bounce a healthy server on a stat error).
 */
function buildNewerThanRunning(app: WebApp, ref: string): boolean {
  try {
    return fs.statSync(ref).mtimeMs > fs.statSync(pidFile(app)).mtimeMs;
  } catch {
    return false;
  }
}

function readPid(app: WebApp): number | null {
  let text: string;
  try {
    text = fs.readFileSync(pidFile(app), "utf8");
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
export function isRunning(app: WebApp = DASHBOARD): [boolean, number | null] {
  const pid = readPid(app);
  if (pid && alive(pid)) {
    return [true, pid];
  }
  return [false, null];
}

export interface WebServerStatus {
  running: boolean;
  pid: number | null;
  port: number;
  url: string;
  healthy: boolean;
}

/** Snapshot for `sandbox status` (and its --json). */
export async function status(app: WebApp = DASHBOARD): Promise<WebServerStatus> {
  const [running, pid] = isRunning(app);
  return {
    running,
    pid,
    port: app.port,
    url: `http://localhost:${app.port}/`,
    healthy: running && (await portOpen(app.port)),
  };
}

/**
 * Build (optional) and start one web server.
 *
 * Non-fatal: on any failure it warns and returns false so `sandbox connect`
 * still finishes bringing up the infra. With `force` it rebuilds and bounces
 * an already-running server (so `sandbox connect` picks up code changes);
 * without it, an already-running server is left as-is.
 */
export async function start(
  app: WebApp = DASHBOARD,
  build = true,
  force = false,
): Promise<boolean> {
  const [running, pid] = isRunning(app);

  // Never bounce ourselves. `sandbox connect` is a tool on apps/mcp, and it
  // reaches infra.up() -> startAll(): a stale dist/ would otherwise make this
  // call SIGTERM the pid in the file, which is the process serving the request.
  if (running && pid === process.pid) {
    success(`${app.label} is this process (pid ${pid}); leaving it running`);
    return true;
  }

  let dir = appDir(app);
  let entry = app.entry;
  let buildRef = path.join(dir, app.buildRef);
  if (!fs.existsSync(path.join(dir, "package.json"))) {
    // No sibling app to build (package install): run the bundle the CLI ships.
    const bundled = app.bundled ? path.join(sandboxRoot(), app.bundled) : null;
    if (!bundled || !fs.existsSync(bundled)) {
      warn(`${app.label} not found at ${dir}; skipping`);
      return false;
    }
    dir = sandboxRoot();
    entry = bundled;
    buildRef = bundled;
    build = false;
  }

  let rebuilt = false;
  if (build && distStale(app)) {
    info(`Building ${app.label} (sources changed)...`);
    let result;
    try {
      result = run(["npm", "run", "build"], { cwd: dir, capture: true, timeout: 300 });
    } catch (err) {
      if (err instanceof ProcError && err.code === "ENOENT") {
        warn(`npm not found; skipping ${app.label}`);
        return false;
      }
      if (err instanceof ProcError && err.code === "ETIMEDOUT") {
        error(`${app.label} build timed out; skipping`);
        return false;
      }
      throw err;
    }
    if (result.status !== 0) {
      // Build failed — leave any running server untouched.
      const detail = (result.stderr.trim() || result.stdout.trim()).slice(-800);
      error(`${app.label} build failed; skipping start:\n${detail}`);
      return false;
    }
    rebuilt = true;
  } else if (build) {
    info(`${app.label} build up to date; skipping build`);
  }

  // A direct `npm run build` can refresh dist without bouncing the server,
  // leaving it serving a stale bundle. Treat that like an explicit force so the
  // bounce path below reloads it.
  if (running && !rebuilt && buildNewerThanRunning(app, buildRef)) {
    info(`Running ${app.label} predates the current build; bouncing to reload it.`);
    force = true;
  }

  // Already running with nothing new to load → leave it as-is.
  if (running && !rebuilt && !force) {
    success(`${app.label} already running (pid ${pid}, http://localhost:${app.port}/)`);
    return true;
  }

  // Bounce a running instance to pick up a rebuild (or a forced restart).
  if (running) {
    await stop(app);
  }

  // Reap anything still holding the port — a server the PID file lost track of
  // (e.g. one left on this port by an older, floating-port launch), so the
  // start below always binds cleanly and we never leak a second server.
  await freePort(app.port);
  const log = logFile(app);
  const env = { ...process.env, PORT: String(app.port), ...(app.env ?? {}) };
  info(`Starting ${app.label} on http://localhost:${app.port}/ ...`);
  // Detached (own session) so it outlives this CLI invocation; logs to a
  // fresh file each start to stay bounded.
  const logFd = fs.openSync(log, "w");
  const child = spawn("node", [entry], {
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
      warn(`node not found; skipping ${app.label}`);
      return false;
    }
    throw spawnResult;
  }
  child.unref();

  fs.writeFileSync(pidFile(app), String(child.pid));

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  // Give it a moment to bind (or die) before reporting.
  for (let i = 0; i < 20; i++) {
    if (exited) {
      error(`${app.label} exited immediately (see ${log})`);
      fs.rmSync(pidFile(app), { force: true });
      return false;
    }
    if (await portOpen(app.port)) {
      success(`${app.label} started (pid ${child.pid}, http://localhost:${app.port}/)`);
      return true;
    }
    await sleep(0.25);
  }

  warn(`${app.label} started (pid ${child.pid}) but port ${app.port} not up yet; check ${log}`);
  return true;
}

/** Stop one web server (SIGTERM, then SIGKILL). Returns true if it was running. */
export async function stop(app: WebApp = DASHBOARD): Promise<boolean> {
  const [running, pid] = isRunning(app);
  if (!running || pid === null) {
    fs.rmSync(pidFile(app), { force: true });
    return false;
  }

  info(`Stopping ${app.label} (pid ${pid})...`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      fs.rmSync(pidFile(app), { force: true });
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

  fs.rmSync(pidFile(app), { force: true });
  // Reap a rogue holder of the port too, in case the PID file had drifted off
  // the process actually bound to it.
  await freePort(app.port);
  success(`${app.label} stopped`);
  return true;
}

/** Bounce a server (no rebuild by default — mirrors `docker compose restart`). */
export async function restart(app: WebApp = DASHBOARD, build = false): Promise<void> {
  await start(app, build, true);
}

/** Start/stop/bounce every managed server, in {@link ALL} order. */
export async function startAll(build = true): Promise<void> {
  for (const app of ALL) {
    await start(app, build);
  }
}

export async function stopAll(): Promise<void> {
  for (const app of ALL) {
    await stop(app);
  }
}

export async function restartAll(build = false): Promise<void> {
  for (const app of ALL) {
    await restart(app, build);
  }
}
