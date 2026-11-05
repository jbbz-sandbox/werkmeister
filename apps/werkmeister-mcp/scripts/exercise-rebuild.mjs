// SW-429: exercise the SW-306 restart guard on this worktree's own built daemon across a "rebuild",
// with two proxy sessions that must see list_changed and the new tool text without reconnecting.
// Run under with-temp-home after a build: node apps/werkmeister-mcp/scripts/exercise-rebuild.mjs <worktree> [port]
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [wt, portArg = "3902"] = process.argv.slice(2);
const PORT = Number(portArg);
if (!wt || !Number.isInteger(PORT)) {
  console.error("usage: exercise-rebuild.mjs <worktree> [port]");
  process.exit(2);
}
if (PORT === 3002) {
  console.error("exercise-rebuild: 3002 is the host daemon's port; use a spare one (default 3902)");
  process.exit(2);
}

// The host daemon runs from the checkout on main (the dev link); bumping its dist would restart it.
const branch = execFileSync("git", ["-C", wt, "rev-parse", "--abbrev-ref", "HEAD"], {
  encoding: "utf8",
}).trim();
if (branch === "main") {
  console.error(
    `exercise-rebuild: ${wt} is on main, likely the host daemon's checkout; use a feature worktree`,
  );
  process.exit(2);
}

const MCP = path.resolve(wt, "apps/werkmeister-mcp");
const SDK = `${MCP}/node_modules/@modelcontextprotocol/sdk/dist/esm/`;
const { Client } = await import(`${SDK}client/index.js`);
const { StdioClientTransport } = await import(`${SDK}client/stdio.js`);
const { ToolListChangedNotificationSchema } = await import(`${SDK}types.js`);

const TOOLS_JS = `${MCP}/dist/daemon_tools.js`;
const ORIGINAL = "`werkmeister machine stats`: CPU";
const REBUILT = `REBUILT ${ORIGINAL}`;
const backup = fs.readFileSync(TOOLS_JS, "utf8");
if (!backup.includes(ORIGINAL)) {
  console.error(
    `exercise-rebuild: ${TOOLS_JS} has no stats description to change; rebuild, or update ORIGINAL`,
  );
  process.exit(1);
}
const HOST = `http://127.0.0.1:${PORT}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const status = async () => {
  try {
    return await (await fetch(`${HOST}/api/status`)).json();
  } catch {
    return null;
  }
};
const waitFor = async (what, check, tries = 300) => {
  for (let i = 0; i < tries; i++) {
    const v = await check();
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};

// launchd stand-in. Not a bash loop or a detached spawn: on macOS both reset XPC_SERVICE_NAME
// to "0", so the guard sees no launchd owner and never exits (stale: true, restartPending: false).
let daemonLog = "";
let daemon = null;
let looping = true;
const startDaemon = () => {
  daemon = spawn(process.execPath, [`${MCP}/dist/main.js`], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      XPC_SERVICE_NAME: "com.werkmeister.daemon",
      // Keep the exercise daemon off the host's Docker engine.
      DOCKER_HOST: "unix:///nonexistent/exercise-rebuild-docker.sock",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  daemon.stderr.on("data", (d) => {
    daemonLog += d;
  });
  daemon.on("exit", (code) => {
    daemonLog += `loop: daemon exited ${code}\n`;
    if (looping) setTimeout(startDaemon, 1000);
  });
};

const cleanup = () => {
  looping = false;
  daemon?.kill("SIGKILL");
  fs.writeFileSync(TOOLS_JS, backup);
};
// finally does not run on a signal; without this a timeout leaves the daemon up and dist edited.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => {
    cleanup();
    process.exit(1);
  });

if (await status()) {
  console.error(`exercise-rebuild: ${HOST} already answers; stop that daemon or pass another port`);
  process.exit(2);
}
const sessions = [];
let failed = false;
startDaemon();
try {
  const s0 = await waitFor("the daemon to answer", status);
  log("daemon up", JSON.stringify({ pid: s0.pid }));
  const token = fs
    .readFileSync(path.join(os.homedir(), ".werkmeister", "mcp-token"), "utf8")
    .trim();

  for (const name of ["session-1", "session-2"]) {
    const client = new Client({ name, version: "0" });
    const changed = [];
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      changed.push(Date.now()),
    );
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [`${MCP}/dist/proxy.js`],
        cwd: os.homedir(),
        stderr: "ignore",
        // with-temp-home pins WERKMEISTER_HOST to a dead port; point the proxies at this daemon.
        env: {
          ...process.env,
          WERKMEISTER_HOST: HOST,
          WERKMEISTER_MCP_PORT: String(PORT),
          WERKMEISTER_MCP_TOKEN: token,
          WERKMEISTER_PROXY_POLL_MS: "2000",
        },
      }),
    );
    sessions.push({ name, client, changed });
    const stats = (await client.listTools()).tools.find((t) => t.name === "stats");
    if (!stats) throw new Error(`${name}: no stats tool listed`);
    log(name, "before:", JSON.stringify(stats.description.slice(0, 40)));
  }

  log("rebuild: change the stats description in dist, bump dist/main.js mtime");
  fs.writeFileSync(TOOLS_JS, backup.replace(ORIGINAL, REBUILT));
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(`${MCP}/dist/main.js`, later, later);

  const s1 = await waitFor(
    "the daemon to restart",
    async () => {
      const s = await status();
      return s && s.pid !== s0.pid ? s : null;
    },
    600,
  );
  log("daemon restarted", JSON.stringify({ pid: s1.pid }));

  for (const s of sessions) {
    await waitFor(`${s.name} list_changed`, () => s.changed.length > 0);
    const stats = (await s.client.listTools()).tools.find((t) => t.name === "stats");
    if (!stats?.description.includes(REBUILT))
      throw new Error(`${s.name}: stats description not rebuilt`);
    log(s.name, "after: list_changed x", s.changed.length, "| new description, same client");
  }
  log("PASS");
} catch (err) {
  failed = true;
  console.error(`FAIL: ${err.message}`);
} finally {
  for (const s of sessions) await s.client.close().catch(() => {});
  cleanup();
  console.log(`--- daemon log (tail) ---\n${daemonLog.split("\n").slice(-6).join("\n")}`);
}
process.exit(failed ? 1 : 0);
