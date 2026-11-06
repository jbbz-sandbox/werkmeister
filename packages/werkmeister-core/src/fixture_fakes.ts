/**
 * The one set of fakes for fixtures and core tests (SW-427): a fake `gh` and `docker` that read one
 * `world.json` and log each call. `seedFixture` and `withFakeGh` both write them, so a gh verb added
 * here reaches every test. They stay generated text, not files in a folder: the CLI bundles core,
 * so a folder read at runtime would be missing from the published build.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/** What the fakes answer. Absent fields take the defaults in FAKE_JS. */
export interface FakeWorld {
  /** `gh issue view` prints it as JSON; null or absent exits 1 ("could not resolve"). */
  issue?: unknown;
  /** `gh auth status` exit code. */
  auth?: number;
  /** `gh repo view` exit code. */
  repoView?: number;
  /** Labels the repo has: `issue edit --add-label` fails for any other; `label create` adds one. */
  labels?: string[];
  /** `gh project item-list` prints `{ items }`. */
  items?: unknown[];
  /** `gh issue list` prints these, for every repo. */
  issues?: unknown[];
  /** `gh pr create` prints it. */
  prUrl?: string;
  /** `gh api repos/…/rules/branches/…` prints these (the base's active rules); default none. */
  rules?: unknown[];
  /** Containers the fake docker shows as running, to the gate's `ps --format {{.Names}}…` only. */
  running?: string[];
  /** Set: `docker exec` runs its last argument (the gate row's command) with `sh -c` here and exits with its code. Absent: exit 0. */
  execCwd?: string;
}

export interface Fakes {
  gh: string;
  docker: string;
  /** One line per gh call (`calls`, the name withFakeGh tests read). */
  ghLog: string;
  dockerLog: string;
}

// Unknown verbs exit 1, so a code path a fake doesn't cover fails loudly (SW-148).
// `pr list` prints nothing: pr open's --jq leaves no URL when no PR is open.
// Only the gate's `ps --format {{.Names}}\t{{.State}}` sees running containers; every other `ps`
// (-q/-aq by label) finds none, so no teardown of a pre-rename project runs on a fake hit.
const FAKE_JS = `import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
const [, , tool, dir, ...args] = process.argv;
const worldFile = dir + "/world.json";
const world = JSON.parse(fs.readFileSync(worldFile, "utf8"));
fs.appendFileSync(dir + "/" + (tool === "gh" ? "calls" : "docker-calls"), args.join(" ").replace(/\\n/g, " ") + "\\n");
const out = (s) => process.stdout.write(s);
const fail = (msg) => { process.stderr.write(msg + "\\n"); process.exit(1); };
const verb = args.slice(0, 2).join(" ");
const labels = world.labels ?? [];
if (tool === "gh") {
  switch (verb) {
    case "auth status":
      process.stderr.write((world.auth ?? 0) === 0 ? "  ✓ Logged in to github.com account octo (keyring)\\n" : "You are not logged into any GitHub hosts.\\n");
      process.exit(world.auth ?? 0);
    case "api user": out("octo\\n"); break;
    // The gate's merge row (SW-457): any other \`gh api\` path still falls through to unhandled.
    case "api " + args[1]:
      if (!args[1].includes("/rules/branches/")) fail("fake gh: unhandled: " + args.join(" "));
      out(JSON.stringify(world.rules ?? []) + "\\n");
      break;
    case "search prs": out("[]\\n"); break;
    case "pr list": break;
    case "pr create": out((world.prUrl ?? "https://github.com/o/app/pull/1") + "\\n"); break;
    case "repo view": process.exit(world.repoView ?? 0);
    case "label create":
      if (!labels.includes(args[2])) fs.writeFileSync(worldFile, JSON.stringify({ ...world, labels: [...labels, args[2]] }));
      break;
    case "issue edit":
      if (args[5] === "--add-label" && !labels.includes(args[6])) fail("'" + args[6] + "' not found");
      break;
    case "issue view":
      if (world.issue == null) fail("could not resolve");
      out(JSON.stringify(world.issue) + "\\n");
      break;
    case "issue list": out(JSON.stringify(world.issues ?? []) + "\\n"); break;
    case "project item-list": out(JSON.stringify({ items: world.items ?? [] }) + "\\n"); break;
    case "issue close": case "issue comment": break;
    default: fail("fake gh: unhandled: " + args.join(" "));
  }
} else {
  switch (args[0]) {
    case "ps":
      if (args.some((a) => a.includes("{{.Names}}"))) out((world.running ?? []).map((c) => c + "\\trunning\\n").join(""));
      break;
    case "inspect": out("false\\n"); break;
    case "exec":
      if (world.execCwd) process.exit(spawnSync("sh", ["-c", args.at(-1)], { cwd: world.execCwd, stdio: "inherit" }).status ?? 1);
      break;
    case "stop": case "compose": case "network": break;
    default: fail("fake docker: unhandled: " + args.join(" "));
  }
}
`;

const shim = (dir: string, tool: string) =>
  `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, "fake.mjs")}' ${tool} '${dir}' "$@"\n`;

/** Write the fakes and *world* into *dir* (created if missing); returns where they are. */
export function writeFakes(dir: string, world: FakeWorld = {}): Fakes {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world));
  fs.writeFileSync(path.join(dir, "fake.mjs"), FAKE_JS);
  for (const tool of ["gh", "docker"])
    fs.writeFileSync(path.join(dir, tool), shim(dir, tool), { mode: 0o755 });
  return {
    gh: path.join(dir, "gh"),
    docker: path.join(dir, "docker"),
    ghLog: path.join(dir, "calls"),
    dockerLog: path.join(dir, "docker-calls"),
  };
}

export interface FakeDaemon {
  /** Point WERKMEISTER_HOST here. */
  url: string;
  /** Each request, `METHOD /path body`, in order. */
  calls: string[];
  close(): Promise<void>;
}

/**
 * A stand-in for the daemon's HTTP API, as the CLI's daemon client speaks it (SW-426, SW-263):
 * `GET /api/status`, and `POST /api/tool` answered from *tools* (name → structuredContent).
 * Any other tool fails with code FAKE_DAEMON, so a path the fake doesn't cover fails loudly.
 */
export async function startFakeDaemon(tools: Record<string, unknown> = {}): Promise<FakeDaemon> {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
    const reply = (status: number, json: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/status") return reply(200, { pid: process.pid, loaded: "fake" });
    if (req.method === "POST" && req.url === "/api/tool") {
      const { name } = JSON.parse(body || "{}") as { name?: string };
      if (name && name in tools) return reply(200, { structuredContent: tools[name], text: "" });
      return reply(501, { error: `fake daemon: unhandled tool ${name}`, code: "FAKE_DAEMON" });
    }
    reply(404, { error: `fake daemon: unhandled ${req.method} ${req.url}`, code: "FAKE_DAEMON" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
