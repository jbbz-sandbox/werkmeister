// SW-1020: the manual real-VS-Code check over a fixture, never the person's daemon or ~/.werkmeister.
// Run on the host (it needs `code`; Node built-ins only, as the host checkout has no node_modules), after
// the extension is built (`dist/extension.cjs`): `node packages/werkmeister-vscode/scripts/manual-dev-host.mjs [quiet|busy]`.
// It opens an Extension Development Host whose cards come from the SW-1019 snapshot fixture:
// - WERKMEISTER_HOST is a fake daemon on 127.0.0.1 that answers status, resources and intercepts from the
//   fixture and 501s every other tool. Without it a temp HOME still reaches the real daemon's 127.0.0.1:3002.
// - WERKMEISTER_BIN (and `werkmeister`, `w9r`, `claude`, `codex`, `opencode` on PATH) are stubs that log
//   their argv and exit 0, so Up, Stop, Restart, Close out and session terminals reach nothing real.
// - HOME, WERKMEISTER_WORKSPACES_ROOT (one empty folder per fixture row), --user-data-dir and
//   --extensions-dir are temp; every inherited WERKMEISTER_* is dropped and WERKMEISTER_FIXTURE=1 is set.
// When the window closes it prints every daemon and CLI call, then deletes the temp folder.
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { snapshot } from "./snapshot-fixture.mjs";

/** A stand-in daemon serving one snapshot; `calls` logs every request. */
export function startFixtureDaemon(kind) {
  const s = snapshot(kind);
  const tools = {
    status: { statuses: s.statuses, infra: s.infra },
    resources: { projects: {}, host: s.host },
    intercepts: {
      available: false,
      installed: false,
      connected_namespace: null,
      intercepts: [],
      remote_services: [],
    },
  };
  const calls = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
    const reply = (status, json) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/status") return reply(200, { pid: process.pid, loaded: "fixture" });
    if (req.method === "POST" && req.url === "/api/tool") {
      const { name } = JSON.parse(body || "{}");
      if (name in tools) return reply(200, { structuredContent: tools[name], text: "" });
      return reply(501, { error: `fixture daemon: no ${name} here`, code: "FIXTURE_DAEMON" });
    }
    reply(404, {
      error: `fixture daemon: unhandled ${req.method} ${req.url}`,
      code: "FIXTURE_DAEMON",
    });
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  );
}

/** The temp folder: home, workspaces root, VS Code dirs and the logging stubs; `env` is what the dev host gets. */
export function prepare(kind, daemonUrl, base = tmpdir()) {
  const root = mkdtempSync(join(base, "w9r-devhost-"));
  const dirs = Object.fromEntries(
    ["home", "workspaces", "user-data", "extensions", "bin"].map((d) => [d, join(root, d)]),
  );
  for (const d of Object.values(dirs)) mkdirSync(d);
  for (const w of snapshot(kind).statuses) mkdirSync(join(dirs.workspaces, w.name));
  const log = join(root, "cli-calls.log");
  writeFileSync(log, "");
  for (const name of ["werkmeister", "w9r", "claude", "codex", "opencode"]) {
    const stub = join(dirs.bin, name);
    writeFileSync(stub, `#!/bin/sh\nprintf '%s %s\\n' ${name} "$*" >> '${log}'\n`);
    chmodSync(stub, 0o755);
  }
  // None of the caller's WERKMEISTER_* gets through: an exported WERKMEISTER_WORKSPACES_ROOT or
  // WERKMEISTER_CONFIG_FILE would point the window at the real workspaces or config.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("WERKMEISTER_")),
  );
  Object.assign(env, {
    HOME: dirs.home,
    WERKMEISTER_FIXTURE: "1",
    WERKMEISTER_HOST: daemonUrl,
    WERKMEISTER_BIN: join(dirs.bin, "werkmeister"),
    WERKMEISTER_WORKSPACES_ROOT: dirs.workspaces,
    PATH: `${dirs.bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  return { root, dirs, log, env };
}

async function main(kind = "busy") {
  const ext = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const daemon = await startFixtureDaemon(kind);
  const run = prepare(kind, daemon.url);
  console.log(`fixture daemon ${daemon.url}, temp folder ${run.root}`);
  try {
    const code = spawn(
      "code",
      [
        "--new-window",
        "--wait",
        `--user-data-dir=${run.dirs["user-data"]}`,
        `--extensions-dir=${run.dirs.extensions}`,
        `--extensionDevelopmentPath=${ext}`,
      ],
      { env: run.env, stdio: "inherit" },
    );
    const status = await new Promise((done) =>
      code.on("exit", done).on("error", (e) => done(e.message)),
    );
    console.log(`code exited: ${status}`);
    // One count per distinct call: the 5 s polls would bury a button's call.
    const counts = new Map();
    for (const c of daemon.calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    const lines = [...counts].map(([c, n]) => `${n}× ${c}`);
    console.log(`--- daemon calls\n${lines.join("\n") || "(none)"}`);
    console.log(`--- CLI calls\n${readFileSync(run.log, "utf8") || "(none)\n"}`);
  } finally {
    await daemon.close();
    rmSync(run.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  await main(process.argv[2]);
