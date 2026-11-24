// SW-1092: the dashboard `werkmeister workspace serve --dashboard` runs, driven tool by tool. The
// bundled server runs from a copy of apps/cli with no node_modules, under the seeded HOME and the
// env that command builds, with an --import preload that logs every spawn, fs write, listen and
// connect. Every tool behind /api/tool is called; none may reach a binary, socket, port or path
// outside the temp HOME. Needs `pnpm turbo run build --filter=werkmeister` first (the test row does).
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardServeEnv, seedDashboardHome } from "werkmeister-core/dashboard_seed";
import { connectInMemoryClient, createServer } from "werkmeister-mcp/server";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliRoot = path.resolve(pkgRoot, "..", "cli");
const started = Date.now();

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "seeded-serve-")));
const home = path.join(tmp, "home");
const auditLog = path.join(tmp, "audit.jsonl");
const app = path.join(tmp, "cli");
fs.mkdirSync(home);

// The server must start with no install: a copy of apps/cli outside any node_modules tree.
fs.cpSync(cliRoot, app, {
  recursive: true,
  filter: (src) => !src.split(path.sep).includes("node_modules") && !src.endsWith(".map"),
});
assert.throws(
  () => createRequire(path.join(app, "dist", "dashboard.js")).resolve("@modelcontextprotocol/sdk"),
  "the copy must not find an installed package",
);

const AUDIT = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
// Opened before patching, and writeSync is never wrapped: appendFileSync calls the patched writeFileSync.
const fd = fs.openSync(process.env.AUDIT_LOG, "a");
const log = (o) => fs.writeSync(fd, JSON.stringify(o) + "\n");
const which = (file, PATH = "") => {
  if (file.includes("/")) return path.resolve(file);
  for (const d of PATH.split(":").filter(Boolean)) {
    const p = path.join(d, file);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return "unresolved:" + file;
};
const envPath = (env) => (env ?? process.env).PATH;
const spawnProto = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (o) {
  const PATH = (o.envPairs ?? []).find((e) => e.startsWith("PATH="))?.slice(5) ?? process.env.PATH;
  log({ kind: "spawn", file: o.file, resolved: which(o.file, PATH), args: o.args?.slice(1) });
  return spawnProto.call(this, o);
};
for (const name of ["spawnSync", "execFileSync"]) {
  const orig = cp[name];
  cp[name] = function (file, args, opts) {
    const o = Array.isArray(args) ? opts : args;
    log({ kind: "spawn", file, resolved: which(file, envPath(o?.env)), args: Array.isArray(args) ? args : [] });
    return orig.apply(this, arguments);
  };
}
const execSync = cp.execSync;
cp.execSync = function (command, o) {
  log({ kind: "spawn", file: "/bin/sh", resolved: "/bin/sh", args: ["-c", command] });
  return execSync.apply(this, arguments);
};
const asPath = (p) =>
  typeof p === "string" ? path.resolve(p) : p instanceof URL ? fileURLToPath(p) : Buffer.isBuffer(p) ? path.resolve(p.toString()) : null;
const writes = (flags) =>
  typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : /[wa+]/.test(String(flags ?? "r"));
const WRITE_ARG = { writeFile: [0], appendFile: [0], mkdir: [0], rm: [0], rmdir: [0], unlink: [0], rename: [0, 1], copyFile: [1], symlink: [1], cp: [1], truncate: [0], chmod: [0], utimes: [0] };
const wrap = (obj, fn, idx, label) => {
  const orig = obj[fn];
  if (typeof orig !== "function") return;
  obj[fn] = function (...a) {
    for (const i of idx) { const p = asPath(a[i]); if (p) log({ kind: "write", fn: label, path: p }); }
    return orig.apply(this, a);
  };
};
for (const [fn, idx] of Object.entries(WRITE_ARG)) {
  wrap(fs, fn, idx, fn);
  wrap(fs, fn + "Sync", idx, fn + "Sync");
  wrap(fs.promises, fn, idx, "promises." + fn);
}
for (const [obj, fn] of [[fs, "open"], [fs, "openSync"], [fs.promises, "open"]]) {
  const orig = obj[fn];
  obj[fn] = function (p, flags, ...rest) {
    const q = asPath(p);
    if (q && writes(flags)) log({ kind: "write", fn, path: q });
    return orig.call(this, p, flags, ...rest);
  };
}
const cws = fs.createWriteStream;
fs.createWriteStream = function (p, ...rest) {
  const q = asPath(p);
  if (q) log({ kind: "write", fn: "createWriteStream", path: q });
  return cws.call(this, p, ...rest);
};
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  this.once("listening", () => log({ kind: "listen", address: this.address() }));
  return listen.apply(this, a);
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...a) {
  const o = Array.isArray(a[0]) ? a[0][0] : a[0];
  if (o && typeof o === "object") log({ kind: "connect", path: o.path, host: o.host, port: o.port });
  else log({ kind: "connect", raw: String(a[0]), host: typeof a[1] === "string" ? a[1] : undefined });
  return connect.apply(this, a);
};
syncBuiltinESMExports();
`;
const auditFile = path.join(tmp, "audit.mjs");
fs.writeFileSync(auditFile, AUDIT);

seedDashboardHome(home);
const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const p = probe.address().port;
    probe.close(() => resolve(p));
  });
});
const env = dashboardServeEnv(home, port);
const child = spawn(
  process.execPath,
  ["--import", auditFile, path.join(app, "dist", "dashboard.js")],
  {
    cwd: home,
    env: { ...env, AUDIT_LOG: auditLog },
    stdio: ["ignore", "inherit", "pipe"],
  },
);
// Also on a failed assertion: never leave a server or the seeded HOME behind.
process.on("exit", () => {
  child.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
});
let stderr = "";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`dashboard did not start:\n${stderr}`)), 30_000);
  child.stderr.on("data", (d) => {
    stderr += d;
    if (stderr.includes("workspaces dashboard:")) {
      clearTimeout(timer);
      resolve();
    }
  });
  child.on("exit", (code) => reject(new Error(`dashboard exited ${code}:\n${stderr}`)));
});

const base = `http://localhost:${port}`;
const page = await fetch(`${base}/`);
assert.equal(page.status, 200);
assert.match(await page.text(), /<html/i);

const call = async (name, args) => {
  try {
    const res = await fetch(`${base}/api/tool`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(10_000),
    });
    return { name, status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { name, status: "timeout", error: e.message };
  }
};

const listed = await call("list-workspaces", {});
const seeded = fs.readdirSync(path.join(home, "ws")).sort();
assert.deepEqual(
  (listed.body?.structuredContent?.workspaces ?? []).map((w) => w.name).sort(),
  seeded,
  JSON.stringify(listed).slice(0, 500),
);

// Arguments from each tool's schema; a workspace-ish field gets a seeded workspace.
const WS_KEYS = new Set(["workspace", "name", "feature", "slug"]);
const argFor = (key, s = {}) => {
  if (WS_KEYS.has(key)) return "seed-working";
  if (s.enum) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  return { number: 1, integer: 1, boolean: true, array: [], object: {} }[t] ?? "x";
};
const { tools } = await (
  await connectInMemoryClient(createServer(), "seeded-serve-test")
).listTools();
assert.ok(tools.length > 30, `only ${tools.length} tools listed`);
const jobs = tools.map((t) => () => {
  const props = t.inputSchema?.properties ?? {};
  const keys = new Set([
    ...(t.inputSchema?.required ?? []),
    ...Object.keys(props).filter((k) => WS_KEYS.has(k)),
  ]);
  return call(t.name, Object.fromEntries([...keys].map((k) => [k, argFor(k, props[k])])));
});
const results = [];
for (let i = 0; i < jobs.length; i += 8)
  results.push(...(await Promise.all(jobs.slice(i, i + 8).map((j) => j()))));
await new Promise((r) => setTimeout(r, 1000)); // detached spawns (open, code) log after their call returns
child.kill("SIGTERM");

const audit = fs
  .readFileSync(auditLog, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const under = (p, root = home) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const bin = path.join(home, "bin");
// git acts only on the seeded workspaces it is pointed at; sysctl only reads (decisions.md 3).
const ALLOWED_REAL = new Set(["git", "sysctl"]);

const spawns = audit.filter((a) => a.kind === "spawn");
// Under HOME, not only bin: WERKMEISTER_FIXTURE's own failing stubs (kubectl) are written to $TMPDIR.
const leaked = spawns.filter((s) => !under(s.resolved) && !ALLOWED_REAL.has(path.basename(s.file)));
assert.deepEqual(leaked, [], "a spawn resolved outside the temp HOME");
assert.ok(
  spawns.every((s) => !ALLOWED_REAL.has(path.basename(s.file)) || !under(s.resolved, bin)),
  "git/sysctl are real, never a stub",
);

const writesOut = audit.filter((a) => a.kind === "write" && !under(a.path));
assert.deepEqual(writesOut, [], "a write landed outside the temp HOME");

const listens = audit.filter((a) => a.kind === "listen");
assert.ok(listens.length >= 1);
for (const l of listens) assert.equal(l.address?.address, "127.0.0.1", JSON.stringify(l));

const okPorts = new Set([port, 65535]);
const badConnects = audit.filter(
  (a) =>
    a.kind === "connect" &&
    (a.path
      ? !under(a.path)
      : !(["127.0.0.1", "localhost", "::1"].includes(a.host) && okPorts.has(Number(a.port)))),
);
assert.deepEqual(badConnects, [], "a connect left the temp HOME or reached a live port");

const stubbed = fs.existsSync(path.join(home, "side-effects.log"))
  ? fs.readFileSync(path.join(home, "side-effects.log"), "utf8")
  : "";
const hit = new Set(
  stubbed
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split(" ")[0]),
);
for (const want of [["osascript", "open"], ["docker"], ["code"]])
  assert.ok(
    want.some((w) => hit.has(w)),
    `no tool reached the ${want.join("/")} stub; stubbed calls:\n${stubbed}\nresults:\n${results.map((r) => `${r.name} ${r.status}`).join("\n")}`,
  );

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `seeded-serve: ${tools.length} tools called, ${spawns.length} spawns (stubbed: ${[...hit].sort().join(", ")}), ` +
    `${audit.filter((a) => a.kind === "write").length} writes, all under the temp HOME; ${secs}s`,
);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
