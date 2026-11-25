/**
 * werkmeister workspace serve <dir>
 * werkmeister workspace serve --dashboard
 *
 * Serve a folder inside this workspace on loopback for a browser check (SW-963), or the workspace's
 * werkmeister worktree's built dashboard from a seeded temp HOME with host side effects stubbed
 * (SW-1092), in a throwaway container with no way out (SW-1135). The checks are `werkmeister-core`'s `staticServer` and `dashboard_seed`.
 */

import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  dashboardContainerArgs,
  dashboardServeEnv,
  dashboardTeardownArgs,
  deadDashboardRuns,
  findDashboardBundle,
  SEEDED_DASHBOARD_HOST_LABEL,
  SEEDED_DASHBOARD_LABEL,
  SEEDED_DASHBOARD_NODE,
  seedDashboardHome,
} from "werkmeister-core/dashboard_seed";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { staticServer } from "werkmeister-core/serve_static";
import { error } from "../lib/config.js";

function fail(message: string): never {
  error(message);
  process.exit(1);
}

/** Resolves with the child's exit code; a task stop signals this process, so pass it on. */
function supervise(child: ChildProcess, name: string): Promise<number> {
  return new Promise<number>((resolve) => {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
    child.on("error", (e) => {
      error(`${name}: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** `docker <args>`: resolves with its exit code and output, never rejects; *started* gets the child, to stop it. */
function docker(
  args: string[],
  started?: (c: ChildProcess) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = execFile("docker", args, (e, stdout, stderr) =>
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
        stdout: String(stdout),
        stderr: String(stderr),
      }),
    );
    started?.(c);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A task stop SIGKILLs serve mid-teardown and leaves its network (SW-1135): remove what a dead serve left. */
// shortcut: a killed run's seeded HOME stays in the OS temp dir (no label names it) until the OS clears it; record it on the network if that piles up.
async function reapDeadRuns(): Promise<void> {
  const fmt = [
    "--filter",
    `label=${SEEDED_DASHBOARD_LABEL}`,
    "--filter",
    `label=${SEEDED_DASHBOARD_HOST_LABEL}=${os.hostname()}`,
    "--format",
    `{{.Label "${SEEDED_DASHBOARD_LABEL}"}}`,
  ];
  const labels =
    (await docker(["ps", "-a", ...fmt])).stdout + (await docker(["network", "ls", ...fmt])).stdout;
  for (const name of deadDashboardRuns(labels, isAlive)) {
    for (const step of dashboardTeardownArgs(name)) await docker(step);
    console.error(`removed ${name}, left by a serve that was killed before its teardown`);
  }
}

async function serveDashboard(root: string): Promise<number> {
  const bundle = findDashboardBundle(root);
  if ("error" in bundle) fail(bundle.error);
  if ((await docker(["version", "--format", "{{.Server.Version}}"])).code !== 0)
    fail(
      "workspace serve --dashboard needs Docker: the seeded dashboard runs in a throwaway container (SW-1135). Start Docker (OrbStack/Docker Desktop) and rerun.",
    );
  await reapDeadRuns();
  // Real path: the engine mounts what the host path resolves to (/var → /private/var on macOS).
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-dashboard-")));
  const port = await freeLoopbackPort();
  const name = `werkmeister-seeded-dashboard-${process.pid}-${port}`;
  const run = dashboardContainerArgs({
    name,
    dist: path.dirname(bundle.entry),
    home,
    port,
    host: os.hostname(),
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    env: dashboardServeEnv(home, port, process.env, "0.0.0.0"),
  });
  // A task stop during setup (a first node:22 pull takes a minute) ends that step, then tears down as below.
  let stopped = false;
  let current: ChildProcess | undefined;
  const stop = () => {
    stopped = true;
    current?.kill("SIGTERM");
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, stop);
  try {
    seedDashboardHome(home, Date.now(), SEEDED_DASHBOARD_NODE);
    for (const step of [run.network, run.app, run.forwarder, run.connect, run.start]) {
      if (stopped) return 130;
      const res = await docker(step, (c) => {
        current = c;
      });
      if (stopped) return 130;
      if (res.code !== 0) {
        error(`docker ${step.slice(0, 2).join(" ")}: ${res.stderr.trim()}`);
        return 1;
      }
    }
    console.log(`http://localhost:${port}/`);
    console.error(
      `seeded HOME ${home}; blocked calls are logged to ${path.join(home, "side-effects.log")}; containers ${name}-app, ${name}-fwd on internal network ${name}`,
    );
    return await supervise(
      spawn("docker", run.attach, { stdio: ["ignore", "inherit", "inherit"] }),
      "dashboard",
    );
  } finally {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.off(sig, stop);
    for (const step of run.teardown) await docker(step);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const cwd = process.cwd();
  const dir = args.dir === undefined ? undefined : String(args.dir);
  if (args.dashboard) {
    if (dir !== undefined) fail("Pass a folder or --dashboard, not both.");
    const root = findRecordRoot(cwd);
    if (!root) fail("Not inside a workspace (no .werkmeister/workspace.yml above it).");
    process.exitCode = await serveDashboard(root);
    return;
  }
  if (dir === undefined) fail("Pass a folder to serve, or --dashboard.");
  const server = staticServer(findRecordRoot(cwd), dir, cwd);
  if ("error" in server) fail(server.error);
  const [cmd, ...argv] = server.argv;
  process.exitCode = await supervise(spawn(cmd as string, argv, { stdio: "inherit" }), "python3");
}
