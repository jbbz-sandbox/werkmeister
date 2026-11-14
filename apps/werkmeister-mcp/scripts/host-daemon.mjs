// SW-679: run this branch's bundled daemon and CLI on the host, on a temp HOME and a free port (never 3002), so a
// daemon-auth or networking change can be called from a container via host.docker.internal.
// The host worktree has no node_modules (they live in the container's volume), so the CLI package is laid out in a
// temp dir as npm publishes it, with node_modules linked to the installed werkmeister's.
// Node builtins only: nothing is installed where this runs.
// usage: node apps/werkmeister-mcp/scripts/host-daemon.mjs [-- <command> [args]...]
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const HOST_DAEMON_PORT = 3002;
const PUBLISHED = ["dist", "infra", "bin", "werkmeister", "w9r", "package.json"];
const fail = (msg) => {
  console.error(`host-daemon: ${msg}`);
  process.exit(2);
};

const args = process.argv.slice(2);
if (args.length && args[0] !== "--") fail("usage: host-daemon.mjs [-- <command> [args]...]");
const command = args.slice(1);

// This script's own worktree, whatever the cwd: another checkout's CLI would be the wrong daemon.
const cli = path.resolve(import.meta.dirname, "../../cli");
if (!fs.existsSync(path.join(cli, "dist/mcp.js")))
  fail(
    `${cli}/dist/mcp.js is not built; build in the container first: docker exec -w /app <container> pnpm turbo run build --filter=werkmeister`,
  );

/** The installed werkmeister's node_modules: the dev link's pnpm folder or a global npm install's. */
function installedModules() {
  if (process.env.WERKMEISTER_MODULES) return path.resolve(process.env.WERKMEISTER_MODULES);
  let bin;
  try {
    bin = execFileSync("sh", ["-c", "command -v werkmeister"], { encoding: "utf8" }).trim();
  } catch {
    fail("no werkmeister on PATH; set WERKMEISTER_MODULES to a werkmeister package's node_modules");
  }
  return path.join(path.dirname(fs.realpathSync(bin)), "node_modules");
}
const modules = installedModules();
// shortcut: presence only, not the version the branch pins; a branch that bumps a dependency needs a matching install.
const deps = Object.keys(
  JSON.parse(fs.readFileSync(path.join(cli, "package.json"), "utf8")).dependencies ?? {},
);
const missing = deps.filter((d) => !fs.existsSync(path.join(modules, d)));
if (missing.length) fail(`${modules} lacks ${missing.join(", ")}; set WERKMEISTER_MODULES`);

async function freePort() {
  for (;;) {
    const srv = net.createServer();
    await new Promise((ok, ko) => srv.once("error", ko).listen(0, "127.0.0.1", ok));
    const { port } = srv.address();
    await new Promise((ok) => srv.close(ok));
    if (port !== HOST_DAEMON_PORT) return port;
  }
}

const tmp = fs.realpathSync(os.tmpdir());
const pkg = fs.mkdtempSync(path.join(tmp, "werkmeister-pkg-"));
const home = fs.mkdtempSync(path.join(tmp, "werkmeister-home-"));
// Copied, not linked: Node resolves a symlinked entry to its real path, back beside the empty node_modules.
for (const f of PUBLISHED)
  if (fs.existsSync(path.join(cli, f)))
    fs.cpSync(path.join(cli, f), path.join(pkg, f), { recursive: true });
fs.symlinkSync(modules, path.join(pkg, "node_modules"));
// launchctl acts on gui/<uid> whatever HOME is: `daemon install` or `machine setup` here would boot out the real daemon
// on 3002 and load one whose entry this script then deletes. crontab is pr-watch's off macOS. Both are blocked.
const blocked = path.join(pkg, ".blocked");
fs.mkdirSync(blocked);
for (const bin of ["launchctl", "crontab"])
  fs.writeFileSync(
    path.join(blocked, bin),
    `#!/bin/sh\necho "host-daemon: ${bin} is blocked under host-daemon.mjs" >&2\nexit 1\n`,
    { mode: 0o755 },
  );

const port = await freePort();
const url = `http://127.0.0.1:${port}`;
// The host shell exports ~/.werkmeister/env.sh (WERKMEISTER_WORKSPACES_ROOT, _ROOT, _CONFIG_FILE, …): each would point
// this daemon back at real workspaces, main's checkout or the real config, so every WERKMEISTER_* goes. With launchd's
// label the restart guard would exit it. WERKMEISTER_FIXTURE keeps it off the shared proxy, hosts file and forwards.
const env = { ...process.env, HOME: home };
for (const k of Object.keys(env))
  if (k.startsWith("WERKMEISTER_") || k === "XPC_SERVICE_NAME") delete env[k];
env.WERKMEISTER_FIXTURE = "1";
env.PATH = `${blocked}${path.delimiter}${env.PATH ?? ""}`;

// Exits once this script is gone (a kill -9 skips cleanup), so no daemon outlives it.
const ORPHAN_WATCH = `data:text/javascript,setInterval(()=>{try{process.kill(${process.pid},0)}catch{process.exit(0)}},1000).unref()`;
let daemonLog = "";
const daemon = spawn(process.execPath, ["--import", ORPHAN_WATCH, path.join(pkg, "dist/mcp.js")], {
  env: {
    ...env,
    PORT: String(port),
    HOST: "127.0.0.1",
    // Keep it off the host's Docker engine: an auth or networking check needs no containers.
    DOCKER_HOST: "unix:///nonexistent/host-daemon-docker.sock",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
daemon.stderr.on("data", (d) => {
  daemonLog += d;
  process.stderr.write(d);
});
let daemonExit = null;
daemon.on("exit", (code) => {
  daemonExit = code;
});

let child = null;
let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  child?.kill();
  daemon.kill("SIGKILL");
  fs.rmSync(pkg, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => process.exit(128 + os.constants.signals[sig]));

// Up only when it answers our own token: another process that took the port in the gap after freePort answers 401.
const tokenFile = path.join(home, ".werkmeister", "mcp-token");
let token = "";
let up = false;
for (let i = 0; i < 300 && daemonExit === null && !up; i++) {
  token ||= fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  up =
    token !== "" &&
    (await fetch(`${url}/api/status`, { headers: { authorization: `Bearer ${token}` } }).then(
      (r) => r.ok && daemonExit === null,
      () => false,
    ));
  if (!up) await sleep(100);
}
if (!up) {
  console.error(
    `host-daemon: the daemon did not answer on ${url} (exit ${daemonExit})\n${daemonLog}`,
  );
  process.exit(1);
}
console.error(
  `host-daemon: WERKMEISTER_HOST=${url} (pid ${daemon.pid}, HOME ${home}, token ${tokenFile})`,
);

if (!command.length) {
  console.error("host-daemon: running until interrupted (Ctrl-C, or kill this pid)");
  daemon.on("exit", (code) => {
    console.error(`host-daemon: the daemon exited ${code}\n${daemonLog}`);
    process.exit(1);
  });
  await new Promise(() => {});
}
child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  env: {
    ...env,
    WERKMEISTER_HOST: url,
    WERKMEISTER_MCP_PORT: String(port),
    WERKMEISTER_MCP_TOKEN: token,
    PATH: `${pkg}${path.delimiter}${env.PATH ?? ""}`,
  },
});
child.on("error", (e) => {
  console.error(`host-daemon: ${command[0]}: ${e.message}`);
  process.exit(127);
});
child.on("exit", (code, signal) => process.exit(code ?? 128 + (os.constants.signals[signal] ?? 0)));
