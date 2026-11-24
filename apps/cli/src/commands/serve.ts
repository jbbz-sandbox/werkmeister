/**
 * werkmeister workspace serve <dir>
 * werkmeister workspace serve --dashboard
 *
 * Serve a folder inside this workspace on loopback for a browser check (SW-963), or the workspace's
 * werkmeister worktree's built dashboard from a seeded temp HOME with host side effects stubbed
 * (SW-1092). The checks are `werkmeister-core`'s `staticServer` and `dashboard_seed`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  dashboardServeEnv,
  findDashboardBundle,
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

async function serveDashboard(root: string): Promise<number> {
  const bundle = findDashboardBundle(root);
  if ("error" in bundle) fail(bundle.error);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-dashboard-"));
  try {
    seedDashboardHome(home);
    const port = await freeLoopbackPort();
    // cwd in the temp HOME too: a relative write must not land in the workspace.
    const child = spawn(process.execPath, [bundle.entry], {
      cwd: home,
      env: dashboardServeEnv(home, port),
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.log(`http://localhost:${port}/`);
    console.error(
      `seeded HOME ${home}; blocked calls are logged to ${path.join(home, "side-effects.log")}`,
    );
    return await supervise(child, "dashboard");
  } finally {
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
