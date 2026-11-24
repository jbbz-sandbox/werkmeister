/**
 * `werkmeister workspace serve --dashboard` (SW-1092): the seeded temp HOME and the env the
 * dashboard runs under for a stage 03 browser check. Started from SW-782's flow-check.mjs.
 *
 * A temp HOME isolates files only: `childEnv()` puts /opt/homebrew/bin, /usr/local/bin and /usr/bin
 * ahead of PATH, and `claude`/`code` resolve by absolute path, so a PATH holding only `node` still
 * reaches them. Every off switch here is an existing override (`*_BIN`, WERKMEISTER_FIXTURE,
 * DOCKER_HOST, WERKMEISTER_HOST), each pointed at a stub that logs and fails.
 */

import * as fs from "node:fs";
import * as path from "node:path";
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
 */
export function seedDashboardHome(home: string, now = Date.now()): string[] {
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
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
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

  // A closed run: working → gate in 2 h gives the working column its p90.
  const closed = workspace("seed-closed-out", "SW-900", null, 3000, 4);
  write(path.join(closed, "closeout.md"), "closed\n");
  write(
    path.join(closed, "usage.json"),
    JSON.stringify({
      schema: 1,
      workspace: "seed-closed-out",
      ticket: "SW-900",
      closedAt: ago(2000),
      firstTurn: ago(2900),
      estUsd: 1,
      totals: { input: 1, output: 1, cacheCreation: 0, cacheRead: 0 },
      activeMinutes: 5,
      wallClockMinutes: 10,
      turns: 3,
    }),
  );
  ev(2780, "gate.start", "seed-closed-out", { run: "c1", retry: 0 });
  ev(2770, "gate.end", "seed-closed-out", { run: "c1", exit: 0 });
  ev(2760, "pr.open", "seed-closed-out", { pr: prUrl(900) });
  ev(2700, "pr.merged", "seed-closed-out", { pr: prUrl(900) });

  workspace("seed-abandoned", "SW-906", "abandoned", 4000, 2);
  ev(3900, "stage.done", "seed-abandoned", { stage: "01_research", commit: "d1" });

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
 */
export function dashboardServeEnv(
  home: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
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
    HOST: "127.0.0.1",
    PORT: String(port),
    ...(env.LANG ? { LANG: env.LANG } : {}),
    ...(env.TZ ? { TZ: env.TZ } : {}),
  };
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
