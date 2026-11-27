/**
 * `werkmeister workspace serve --dashboard` (SW-1092): the seeded temp HOME and the env the
 * dashboard runs under for a stage 03 browser check. Started from SW-782's flow-check.mjs.
 *
 * A temp HOME isolates files only: `childEnv()` puts /opt/homebrew/bin, /usr/local/bin and /usr/bin
 * ahead of PATH, and `claude`/`code` resolve by absolute path, so a PATH holding only `node` still
 * reaches them. Every off switch here is an existing override (`*_BIN`, WERKMEISTER_FIXTURE,
 * DOCKER_HOST, WERKMEISTER_HOST), each pointed at a stub that logs and fails.
 *
 * The stubs steer honest code; the boundary is {@link dashboardContainerArgs} (SW-1135): the
 * served bundle is the worktree's own code, so it runs in a container with no way out.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gateRowKind } from "./metrics.js";
import type { Lifecycle } from "./pr_lifecycle.js";

/** One seeded workspace per state, so every column and badge has a card. */
export const SEEDED_STATES: readonly Lifecycle[] = [
  "working",
  "ready",
  "pr-open",
  "merged",
  "shipped",
  "closed-out",
  "abandoned",
];

/** Each stub appends `<name> <args>` to `$HOME/side-effects.log` and exits 1. */
export const STUBBED_BINS: readonly string[] = [
  "docker",
  "claude",
  "codex",
  "opencode",
  "code",
  "kubectl",
  "gh",
  "werkmeister",
  "w9r",
  "osascript",
  "open",
  "xdg-open",
  "telepresence",
];

const STAGES = ["01_research", "02_spec", "03_implement", "04_propose"];

/**
 * Seed *home* (an empty folder) with a config, a workspace in each lifecycle state, two transcripts
 * per workspace, a metrics event log and the stub bin folder. Returns every path it wrote.
 *
 * @param home - The temp HOME.
 * @param now - The clock the seeded ages count back from.
 * @param nodePath - What `bin/node` links to: the image's node when the dashboard runs in a container.
 */
export function seedDashboardHome(
  home: string,
  now = Date.now(),
  nodePath = process.execPath,
): string[] {
  const written: string[] = [];
  const mkdir = (p: string) => {
    fs.mkdirSync(p, { recursive: true });
    written.push(p);
  };
  const write = (p: string, body: string, mode?: number) => {
    mkdir(path.dirname(p));
    fs.writeFileSync(p, body, { mode });
    written.push(p);
  };
  const wm = path.join(home, ".werkmeister");
  const root = path.join(home, "ws");
  const bin = path.join(home, "bin");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const prUrl = (n: number) => `https://github.com/o/app/pull/${n}`;
  const events: Record<string, unknown>[] = [];
  const ev = (min: number, event: string, workspace: string, extra: Record<string, unknown> = {}) =>
    events.push({ v: 1, at: ago(min), event, workspace, ...extra });
  const line = (o: unknown) => `${JSON.stringify(o)}\n`;

  mkdir(path.join(home, "tmp"));
  mkdir(bin);
  fs.symlinkSync(nodePath, path.join(bin, "node"));
  written.push(path.join(bin, "node"));
  for (const name of STUBBED_BINS)
    write(
      path.join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$HOME/side-effects.log"\necho "${name} is stubbed in the seeded dashboard" >&2\nexit 1\n`,
      0o755,
    );
  write(path.join(wm, "config.yaml"), "version: 1\n");

  const workspace = (
    name: string,
    ticket: string,
    prStatus: string | null,
    firstTurnMin: number,
    stagesDone: number,
  ) => {
    const ws = path.join(root, name);
    write(path.join(ws, ".werkmeister", "workspace.yml"), `issue_id: ${ticket}\n`);
    STAGES.forEach((s, i) => {
      const out = path.join(ws, "stages", s, "output");
      if (i < stagesDone) write(path.join(out, "done.md"), "done\n");
      else mkdir(out);
    });
    if (prStatus)
      write(
        path.join(ws, "stages", "04_propose", "output", "pr-app.md"),
        `---\nrepo: o/app\nbranch: me/${name}\nbase: main\nstatus: ${prStatus}\nurl: ${prUrl(ticket.length + name.length)}\n---\n# ${ticket}\n`,
      );
    // Two sessions, so the chat panel's picker shows.
    const project = path.join(home, ".claude", "projects", ws.replace(/[^a-zA-Z0-9]/g, "-"));
    const n = String(name.length).padStart(12, "0");
    for (const [id, start, title] of [
      [`aaaaaaaa-0000-0000-0000-${n}`, firstTurnMin, "Research and spec"],
      [`bbbbbbbb-0000-0000-0000-${n}`, firstTurnMin / 2, "Implement"],
    ] as const)
      write(
        path.join(project, `${id}.jsonl`),
        line({ type: "ai-title", sessionId: id, aiTitle: title }) +
          line({
            type: "user",
            sessionId: id,
            timestamp: ago(start),
            message: { role: "user", content: "go" },
          }) +
          line({
            type: "assistant",
            sessionId: id,
            timestamp: ago(start - 1),
            message: {
              role: "assistant",
              model: "claude-opus-5-5",
              content: [{ type: "text", text: `${title}: done.` }],
              usage: { input_tokens: 1200, output_tokens: 300 },
            },
          }),
      );
    return ws;
  };

  // Working, stage 03, 6 h old (red past its p90), waiting on the person for 42 min.
  const working = workspace("seed-working", "SW-901", null, 360, 2);
  write(
    path.join(working, ".werkmeister", "sessions", "s1.json"),
    JSON.stringify({
      status: "idle",
      at: ago(1),
      ask: { kind: "question", what: "Approve?", at: ago(42), source: "session" },
    }),
  );
  ev(330, "queue.admit", "seed-working", { feature: "seed-working", waited_s: 900 });
  ev(300, "stage.done", "seed-working", { stage: "01_research", commit: "a1" });
  ev(250, "answer", "seed-working", { session: "s", waited_s: 1800 });
  ev(120, "stage.done", "seed-working", { stage: "02_spec", commit: "a2" });

  // Ready: the gate has run 20 min, after one exit-75 retry.
  workspace("seed-ready", "SW-902", "approved", 500, 3);
  ev(400, "stage.done", "seed-ready", { stage: "01_research", commit: "b1" });
  ev(300, "stage.done", "seed-ready", { stage: "02_spec", commit: "b2" });
  ev(200, "stage.done", "seed-ready", { stage: "03_implement", commit: "b3" });
  ev(40, "gate.start", "seed-ready", { run: "r1", retry: 0 });
  ev(35, "gate.end", "seed-ready", { run: "r1", exit: 75 });
  ev(20, "gate.start", "seed-ready", { run: "r2", retry: 1 });

  workspace("seed-pr-open", "SW-903", "open", 900, 4);
  ev(800, "stage.done", "seed-pr-open", { stage: "03_implement", commit: "p3" });
  ev(120, "gate.start", "seed-pr-open", { run: "p1", retry: 0 });
  ev(100, "gate.end", "seed-pr-open", { run: "p1", exit: 1 });
  ev(95, "gate.start", "seed-pr-open", { run: "p2", retry: 1 });
  ev(92, "gate.end", "seed-pr-open", { run: "p2", exit: 0 });
  ev(90, "pr.open", "seed-pr-open", { pr: prUrl(7) });

  workspace("seed-merged", "SW-904", "merged", 1200, 4);
  ev(200, "pr.open", "seed-merged", { pr: prUrl(13) });
  ev(30, "pr.merged", "seed-merged", { pr: prUrl(13) });

  workspace("seed-shipped", "SW-905", "shipped", 2000, 4);
  ev(1500, "pr.open", "seed-shipped", { pr: prUrl(21) });
  ev(1400, "pr.merged", "seed-shipped", { pr: prUrl(21) });
  ev(1300, "release", "seed-shipped", { pr: prUrl(21), tag: "v1.2.0" });

  // SW-1100: three model families per run, priced at the built-in rates ($/M: input, output, cache write, cache read).
  const SEED_MODELS: [model: string, tokens: number[], rate: number[] | null][] = [
    ["claude-opus-5-5", [40e3, 120e3, 600e3, 9e6], [4, 20, 5, 0.2]],
    ["claude-sonnet-5-5", [10e3, 30e3, 200e3, 2e6], [2, 10, 2.5, 0.1]],
    ["claude-haiku-4-5", [5e3, 10e3, 50e3, 400e3], [1, 5, 1.25, 0.1]],
  ];
  const UNPRICED_MODEL: (typeof SEED_MODELS)[number] = [
    "claude-unpriced-9",
    [20e3, 8e3, 60e3, 900e3],
    null,
  ];
  const totalsOf = ([input = 0, output = 0, cacheCreation = 0, cacheRead = 0]: number[]) => ({
    input,
    output,
    cacheCreation,
    cacheRead,
  });
  // Share of each run's tokens per stage; the rest is after the last stage.
  const STAGE_SHARE = [0.1, 0.15, 0.55, 0.1];

  // Closed runs; *stages* is minutes per stage, counted back from *firstTurnMin*; stages past its
  // length are not reached.
  const closedRun = (
    name: string,
    ticket: string,
    version: string,
    firstTurnMin: number,
    closedMin: number,
    stages: number[],
    { outcome = "shipped", scale = 1, unpriced = false } = {},
  ) => {
    const ws = workspace(name, ticket, null, firstTurnMin, stages.length);
    write(path.join(ws, "closeout.md"), "closed\n");
    const models = unpriced ? [UNPRICED_MODEL] : SEED_MODELS;
    const byModel = models.map(([model, t, rate]) => {
      const n = t.map((v) => Math.round(v * scale));
      return {
        model,
        totals: totalsOf(n),
        estUsd: rate ? n.reduce((a, v, i) => a + (v / 1e6) * (rate[i] ?? 0), 0) : null,
      };
    });
    const total = [0, 1, 2, 3].map((k) =>
      byModel.reduce((a, m) => a + (Object.values(m.totals)[k] ?? 0), 0),
    );
    const used = [0, 0, 0, 0];
    let at = firstTurnMin;
    const timings = STAGES.map((stage, i) => {
      if (i >= stages.length) return { stage, finishedAt: null, minutes: null, tokens: null };
      at -= stages[i] ?? 0;
      ev(at, "stage.done", name, { stage, commit: `${name}-${i}` });
      const part = total.map((v) => Math.round(v * (STAGE_SHARE[i] ?? 0)));
      part.forEach((v, k) => {
        used[k] = (used[k] ?? 0) + v;
      });
      return { stage, finishedAt: ago(at), minutes: stages[i], tokens: totalsOf(part) };
    });
    const priced = byModel.flatMap((m) => (m.estUsd === null ? [] : [m.estUsd]));
    write(
      path.join(ws, "usage.json"),
      JSON.stringify({
        schema: 1,
        workspace: name,
        ticket,
        outcome,
        werkmeister: { version, commit: null },
        closedAt: ago(closedMin),
        firstTurn: ago(firstTurnMin),
        estUsd: priced.length ? priced.reduce((a, v) => a + v, 0) : null,
        totals: totalsOf(total),
        byModel,
        activeMinutes: 5,
        wallClockMinutes: 10,
        turns: 3,
        stages: timings,
        unstagedTokens: totalsOf(total.map((v, k) => v - (used[k] ?? 0))),
      }),
    );
    return ws;
  };

  // A closed run: working → gate in 2 h gives the working column its p90.
  closedRun("seed-closed-out", "SW-900", "0.111.0", 2900, 2000, [50, 30, 30, 25]);
  // SW-1100: spend on abandoned work, and a run with no price for the "without a price" notes.
  closedRun("seed-abandoned-spend", "SW-920", "0.111.0", 2400, 1800, [60, 40], {
    outcome: "abandoned",
    scale: 0.5,
  });
  closedRun("seed-unpriced", "SW-921", "0.111.0", 1700, 1200, [40, 30, 90, 20], {
    unpriced: true,
  });

  // SW-1099: three weekly closed runs on two versions, 03_implement the longest (the seeded
  // bottleneck), each with a person wait in 01_research, a capacity wait across the 02_spec →
  // 03_implement boundary and a person wait in 03_implement, then merged and released.
  const WEEK = 7 * 1440;
  for (const k of [1, 2, 3]) {
    const name = `seed-closed-${k}`;
    const first = k * WEEK + 3000;
    const implement = 1300 + k * 200;
    const done = first - 1100 - implement;
    closedRun(name, `SW-91${k}`, k === 3 ? "0.110.0" : "0.111.0", first, done - 400, [
      600,
      300,
      implement,
      200,
    ]);
    ev(first - 500, "answer", name, { session: "s", waited_s: 3600 });
    ev(first - 930, "queue.admit", name, { feature: name, waited_s: 3600 });
    ev(first - 1500, "answer", name, { session: "s", waited_s: 240 * 60 });
    ev(done - 50, "pr.open", name, { pr: prUrl(30 + k) });
    ev(done - 100, "pr.merged", name, { pr: prUrl(30 + k) });
    ev(done - 300, "release", name, { pr: prUrl(30 + k), tag: `v0.11${k}.0` });
  }
  ev(2780, "gate.start", "seed-closed-out", { run: "c1", retry: 0 });
  ev(2770, "gate.end", "seed-closed-out", { run: "c1", exit: 0 });
  ev(2760, "pr.open", "seed-closed-out", { pr: prUrl(900) });
  ev(2700, "pr.merged", "seed-closed-out", { pr: prUrl(900) });

  workspace("seed-abandoned", "SW-906", "abandoned", 4000, 2);
  ev(3900, "stage.done", "seed-abandoned", { stage: "01_research", commit: "d1" });

  // SW-1101: seven weeks of gates, three runs a week, for the gate and test charts. pkg-b slows in
  // the last complete week (the regression banner); pkg-c is partly cached.
  // Placed by ISO week (Monday 00:00Z), not "w weeks ago", so a week's runs share a bucket on any weekday.
  const today = new Date(now);
  const sinceMonday =
    ((today.getUTCDay() + 6) % 7) * 1440 + today.getUTCHours() * 60 + today.getUTCMinutes();
  for (let w = 0; w < 7; w++) {
    // In the first minutes of a Monday this week has no past to place runs in.
    if (w === 0 && sinceMonday < 10) continue;
    const name = `seed-gate-w${w}`;
    for (let i = 0; i < 3; i++) {
      // This week: spread over the part already past; earlier weeks: around their Thursday noon.
      const end =
        w === 0
          ? Math.floor(sinceMonday * (0.3 + 0.2 * i)) + 1
          : sinceMonday + (w - 1) * 7 * 1440 + 3.5 * 1440 + i * 120;
      const run = `t${w}${i}`;
      const testMs = {
        "pkg-a": 120_000 + i * 6000,
        "pkg-b": (w === 1 ? 300_000 : 180_000) + i * 6000,
        "pkg-c": 30_000,
      };
      const testRow = testMs["pkg-a"] + testMs["pkg-b"] + testMs["pkg-c"] + 60_000;
      ev(end + 20, "gate.start", name, { run, retry: i });
      for (const [row, ms] of [
        ["start werkmeister-core", 40_000],
        ["lint", 60_000],
        ["test werkmeister-core", testRow],
        ["review", 2000],
      ] as const)
        ev(end, "gate.row", name, {
          run,
          row,
          row_kind: gateRowKind(row),
          duration_ms: ms,
          result: "ok",
        });
      for (const [pkg, ms] of Object.entries(testMs))
        ev(end, "test.run", name, {
          run,
          row: "test werkmeister-core",
          package: pkg,
          task: "test:coverage",
          duration_ms: ms,
          result: "ok",
          cached: false,
          tests: 40,
          failures: 0,
        });
      ev(end, "test.run", name, {
        run,
        row: "test werkmeister-core",
        package: "pkg-c",
        task: "test:coverage",
        duration_ms: 15,
        result: "ok",
        cached: true,
      });
      ev(end, "gate.end", name, { run, exit: w === 3 && i === 0 ? 1 : 0 });
    }
  }

  const byMonth = new Map<string, Record<string, unknown>[]>();
  for (const e of events) {
    const month = String(e.at).slice(0, 7);
    byMonth.set(month, [...(byMonth.get(month) ?? []), e]);
  }
  for (const [month, list] of byMonth)
    write(path.join(wm, "metrics", `events-${month}.jsonl`), list.map(line).join(""));
  return written;
}

/**
 * The dashboard child's whole env, built from nothing so no token, `NODE_OPTIONS` or real path
 * in the caller's env reaches it.
 *
 * @param home - The seeded temp HOME.
 * @param port - The loopback port to listen on.
 * @param env - Where `LANG` and `TZ` are copied from, when set.
 * @param listen - The address it binds: `0.0.0.0` in a container, whose forwarder publishes only loopback.
 */
export function dashboardServeEnv(
  home: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
  listen = "127.0.0.1",
): NodeJS.ProcessEnv {
  const bin = path.join(home, "bin");
  const stub = (name: string) => path.join(bin, name);
  return {
    HOME: home,
    WERKMEISTER_TEMP_HOME: home,
    TMPDIR: path.join(home, "tmp"),
    PATH: bin,
    WERKMEISTER_CONFIG_FILE: path.join(home, ".werkmeister", "config.yaml"),
    WERKMEISTER_WORKSPACES_ROOT: path.join(home, "ws"),
    WERKMEISTER_FIXTURE: "1",
    WERKMEISTER_DOCKER_BIN: stub("docker"),
    WERKMEISTER_GH_BIN: stub("gh"),
    WERKMEISTER_BIN: stub("werkmeister"),
    CLAUDE_BIN: stub("claude"),
    CODEX_BIN: stub("codex"),
    OPENCODE_BIN: stub("opencode"),
    VSCODE_BIN: stub("code"),
    DOCKER_HOST: `unix://${path.join(home, "no-docker.sock")}`,
    // Nothing listens on 65535, the same dead daemon address with-temp-home uses.
    WERKMEISTER_HOST: "http://127.0.0.1:65535",
    WERKMEISTER_MCP_PORT: "65535",
    // git stays real; the seeded workspaces aren't repos, so stop its walk up at HOME.
    GIT_CEILING_DIRECTORIES: home,
    // open-workspaces-ui and status health-check this port: point it at this server, not the host's 3001.
    WERKMEISTER_DASHBOARD_PORT: String(port),
    HOST: listen,
    PORT: String(port),
    ...(env.LANG ? { LANG: env.LANG } : {}),
    ...(env.TZ ? { TZ: env.TZ } : {}),
  };
}

/** Every node service in the registry runs on this tag, and it has the `git` the dashboard keeps real. */
export const SEEDED_DASHBOARD_IMAGE = "node:22";
/** On both containers and the network, so a run SIGKILLed before its teardown can be found. */
export const SEEDED_DASHBOARD_LABEL = "werkmeister.seeded-dashboard";
/**
 * The hostname of the serve that made the run: pids are per pid namespace while the engine is shared
 * (a werkmeister-core container has the docker socket), so a reaper judges only its own host's runs.
 */
export const SEEDED_DASHBOARD_HOST_LABEL = "werkmeister.seeded-dashboard.host";
/** Where `node:22` keeps node: `bin/node` in the seeded HOME links here when it runs in the container. */
export const SEEDED_DASHBOARD_NODE = "/usr/local/bin/node";

// The forwarder's whole program, passed inline so none of it comes from the worktree: argv is <host> <port>.
const FORWARD_JS = `const n=require("net");const[h,p]=process.argv.slice(1);n.createServer(c=>{const u=n.connect(+p,h);c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())}).listen(+p,"0.0.0.0")`;

/**
 * The `docker` argv (without `docker`) for one seeded dashboard run (SW-1135). The dashboard sits
 * alone on an `--internal` network, so edited bundle code reaches neither the host's daemon nor
 * the internet; its only mounts are *dist* read-only and *home*, each at its host path so the
 * seeded paths hold. A forwarder on the default bridge and that network publishes only
 * `127.0.0.1:<port>`: a container on an internal network alone gets no published port.
 * Run in order: network, app, forwarder, connect, start, then supervise attach: the app runs in the
 * foreground there, so its output shows and its exit code is the run's. Teardown removes all three.
 */
export function dashboardContainerArgs(o: {
  name: string;
  dist: string;
  home: string;
  port: number;
  uid: number;
  gid: number;
  host: string;
  env: NodeJS.ProcessEnv;
}): {
  network: string[];
  app: string[];
  forwarder: string[];
  connect: string[];
  start: string[];
  attach: string[];
  teardown: string[][];
} {
  const label = [
    ...["--label", `${SEEDED_DASHBOARD_LABEL}=${o.name}`],
    ...["--label", `${SEEDED_DASHBOARD_HOST_LABEL}=${o.host}`],
  ];
  const locked = [
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  const app = `${o.name}-app`;
  const fwd = `${o.name}-fwd`;
  const env = Object.keys(o.env)
    .sort()
    .flatMap((k) => ["-e", `${k}=${o.env[k]}`]);
  return {
    network: ["network", "create", "--internal", ...label, o.name],
    app: [
      ...["create", "--rm", "--name", app, ...label, "--network", o.name, ...locked],
      ...["--user", `${o.uid}:${o.gid}`],
      ...["-v", `${o.dist}:${o.dist}:ro`, "-v", `${o.home}:${o.home}`, "-w", o.home],
      ...env,
      // The seeded PATH holds only stubs, which hides the image's docker-entrypoint.sh: name node itself.
      ...[
        "--entrypoint",
        SEEDED_DASHBOARD_NODE,
        SEEDED_DASHBOARD_IMAGE,
        path.join(o.dist, "dashboard.js"),
      ],
    ],
    forwarder: [
      ...["create", "--rm", "--name", fwd, ...label, ...locked],
      ...["-p", `127.0.0.1:${o.port}:${o.port}`],
      ...[SEEDED_DASHBOARD_IMAGE, "node", "-e", FORWARD_JS, app, String(o.port)],
    ],
    connect: ["network", "connect", o.name, fwd],
    start: ["start", fwd],
    attach: ["start", "-a", app],
    teardown: dashboardTeardownArgs(o.name),
  };
}

/** Removes run *name*'s two containers, then its network (a network with containers attached stays). */
export function dashboardTeardownArgs(name: string): string[][] {
  return [
    ["rm", "-f", `${name}-app`, `${name}-fwd`],
    ["network", "rm", name],
  ];
}

/**
 * Runs left by a serve that died before its teardown (a task stop's SIGKILL), from the label values
 * `docker ps -a` and `docker network ls` print: names are `<prefix>-<pid>-<port>`, and only a run whose
 * pid *isAlive* says is gone is returned, so a live serve's run is never touched.
 */
export function deadDashboardRuns(labels: string, isAlive: (pid: number) => boolean): string[] {
  const dead = new Set<string>();
  for (const name of labels.split("\n")) {
    const pid = Number(/^werkmeister-seeded-dashboard-(\d+)-\d+$/.exec(name.trim())?.[1]);
    if (pid && !isAlive(pid)) dead.add(name.trim());
  }
  return [...dead];
}

/**
 * The built, bundled dashboard of the one werkmeister worktree directly under *workspaceRoot*:
 * `apps/cli/dist/dashboard.js` needs no `node_modules`. Never the running CLI's own copy, which is
 * main's dashboard, not the branch's.
 */
export function findDashboardBundle(workspaceRoot: string): { entry: string } | { error: string } {
  const worktrees = fs
    .readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => path.join(workspaceRoot, d.name))
    .filter((dir) => {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(dir, "apps", "cli", "package.json"), "utf8"),
        );
        return pkg.name === "werkmeister";
      } catch {
        return false;
      }
    });
  if (!worktrees.length)
    return {
      error:
        "No werkmeister worktree in this workspace: --dashboard serves a werkmeister worktree's built dashboard.",
    };
  if (worktrees.length > 1)
    return {
      error: `More than one werkmeister worktree in this workspace: ${worktrees.join(", ")}.`,
    };
  const dist = path.join(worktrees[0] as string, "apps", "cli", "dist");
  const entry = path.join(dist, "dashboard.js");
  if (!fs.existsSync(entry) || !fs.existsSync(path.join(dist, "browser.html")))
    return {
      error: `${worktrees[0]} has no built dashboard: run the werkmeister-core test row's build in the container first (pnpm turbo run build --filter=werkmeister).`,
    };
  return { entry };
}
