/**
 * werkmeister internal fixture [--gate] [--bare] [--daemon] [--exec-runs] [--merged] [--behind] [--slots-full] [--postmortem] [--workspace-repo] [--worktrees] [--jira] [--running <file>] [--queue <feature>[,<feature>]... | --queue <feature>:<waitedMin>[:<service>,...]]... [--issue <ref>] [--pr-field <key>=<value>]... [--pr-line '<key>: <value>']... [--workspace <file>] [--config <file>] [--services <file>] [--fragment <file>] [--change <path>] [--change-base <file>] [--change-branch <file>] [--fragment-change <file>] [--stale-compose] [--workflow <dir> [--workflow-in repo]] [--print <file>]... <args> [--then <args> | --then-append <path> <text>]...
 *
 * What `.werkmeister/bin/with-fixture-workspace` runs (SW-292): seeds a fixture in a temp folder,
 * runs this same build with each `<args>` from the fixture workspace (stopping at the first
 * failure), prints each `--print` file and the fake gh/docker (and, with --daemon, daemon; with --jira, Jira) calls,
 * then deletes the folder.
 * main.ts hands it raw argv, so a werkmeister flag like `--services` never reaches commander here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeDaemon, startFakeJira } from "werkmeister-core/fixture_fakes";
import {
  type Fixture,
  type FixtureContainer,
  type FixtureWorkflow,
  fixturePreset,
  seedFixture,
} from "werkmeister-core/fixture_workspace";
import YAML from "yaml";

const USAGE =
  "usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--daemon] [--exec-runs] [--merged] [--behind] [--slots-full] [--postmortem] [--workspace-repo] [--worktrees] [--jira] [--running <file>] [--queue <feature>[,<feature>]... | --queue <feature>:<waitedMin>[:<service>,...]]... [--issue <ref>] [--pr-field <key>=<value>]... [--pr-line '<key>: <value>']... [--workspace <file>] [--config <file>] [--services <file>] [--fragment <file>] [--change <path>] [--change-base <file>] [--change-branch <file>] [--fragment-change <file>] [--stale-compose] [--workflow <dir> [--workflow-in repo]] [--print <file>]... <werkmeister args> [--then <werkmeister args> | --then-append <path> <text>]...\n(fixture options come first: the first other argument starts the werkmeister args)";

/** PR-file keys the pre-approved wrapper may set: none reaches a git or Claude call (SW-514). */
const PR_KEYS = "skip_release|skip_exercise|skip_review|release|status|url";
// url reaches only the fixture's fake gh and the metrics log: a PR on the fixture's own o/ repos (SW-1126).
const PR_URL = /^https:\/\/github\.com\/o\/[A-Za-z0-9][\w.-]*\/pull\/\d+$/;
// Not status: the PR file always has its own status line, and --pr-field status= already writes it verbatim.
const PR_LINE_KEYS = "skip_release|skip_exercise|skip_review|release";
const LINE_BREAK = /[\r\n\u2028\u2029\u0085]/;

/**
 * *p* resolved under *base*, real path, or null when it escapes it (absolute, `..`, a symlink out).
 * The wrapper is pre-approved, so it must not read or print files outside the fixture (or, for
 * a file flag, outside the worktree of the running build: SW-916).
 */
export function inside(base: string | null, p: string): string | null {
  if (base === null) return null;
  const b = fs.realpathSync(base);
  let r = path.resolve(b, p);
  if (fs.existsSync(r)) r = fs.realpathSync(r);
  return r.startsWith(b + path.sep) ? r : null;
}

const BUILD_ENTRY = path.join("apps", "cli", "dist", "main.js");

/**
 * The worktree of the running build (`<wt>/apps/cli/dist/main.js`): file flags resolve here, whatever the shell's cwd, since the allow rule doesn't pin it (SW-916).
 * null for any other layout (an npm global's `<prefix>/lib/node_modules/werkmeister/dist/main.js`), so every file flag is refused (SW-1064).
 */
const cliWorktree = (): string | null => {
  const entry = path.resolve(process.argv[1] as string);
  return entry.endsWith(path.sep + BUILD_ENTRY)
    ? path.resolve(path.dirname(entry), "../../..")
    : null;
};

/**
 * A file flag's refusal. Outside the worktree it names where the path resolved and the base:
 * a host absolute path given in the container resolves against /app (SW-1083).
 */
function outside(base: string | null, p: string): { file?: string; base?: string } {
  if (base === null || inside(base, p)) return {};
  const b = fs.realpathSync(base);
  return { file: path.resolve(b, p), base: b };
}

export function parse(argv: string[], base = cliWorktree()) {
  const opts = {
    gate: false,
    bare: false,
    daemon: false,
    execRuns: false,
    merged: false,
    behind: false,
    slotsFull: false,
    postmortem: false,
    workspaceRepo: false,
    worktrees: false,
    jira: false,
    issue: undefined as string | undefined,
    prFields: undefined as Record<string, string> | undefined,
    prLines: undefined as string[] | undefined,
    services: undefined as string | undefined,
    fragment: undefined as string | undefined,
    fragmentChange: undefined as string | undefined,
    staleCompose: false,
    changeBase: undefined as string | undefined,
    changeBranch: undefined as string | undefined,
    change: undefined as string | undefined,
    workspace: undefined as Record<string, unknown> | undefined,
    config: undefined as Record<string, unknown> | undefined,
    containers: undefined as FixtureContainer[] | undefined,
    queue: undefined as string[] | undefined,
    workflow: undefined as FixtureWorkflow | undefined,
    workflowIn: undefined as "repo" | undefined,
  };
  const print: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") opts.gate = true;
    else if (a === "--bare") opts.bare = true;
    else if (a === "--daemon") opts.daemon = true;
    // First only, so the workspace's prefix ask rule sees it (workspaceAskRules); later, it is a werkmeister arg.
    else if (a === "--exec-runs" && i === 0) opts.execRuns = true;
    else if (a === "--merged") opts.merged = true;
    else if (a === "--behind") opts.behind = true;
    else if (a === "--slots-full") opts.slotsFull = true;
    else if (a === "--postmortem") opts.postmortem = true;
    else if (a === "--workspace-repo") opts.workspaceRepo = true;
    else if (a === "--worktrees") opts.worktrees = true;
    else if (a === "--jira") opts.jira = true;
    else if (a === "--stale-compose") opts.staleCompose = true;
    else if (a === "--queue" && argv[i + 1] !== undefined) {
      // An entry with a wait is one waiter whose commas list its services (SW-809).
      const v = argv[++i] as string;
      opts.queue = [...(opts.queue ?? []), ...(v.includes(":") ? [v] : v.split(","))];
    } else if (a === "--running" && argv[i + 1] !== undefined) {
      // fixturePreset checks each value; here only the shape: five tab-separated columns a line, six with the running execs (SW-856), seven with asking 0|1 (SW-1147).
      const p = argv[++i] as string;
      const file = inside(base, p);
      if (!file || !fs.existsSync(file)) return { bad: a, ...outside(base, p) };
      const rows = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => l.split("\t"));
      if (
        rows.some(
          (r) => r.length < 5 || r.length > 7 || (r.length === 7 && !/^[01]$/.test(r[6] as string)),
        )
      )
        return { bad: a };
      opts.containers = rows.map(
        ([feature, workspace, startedAt, memory, nanoCpus, execs, asking]) => ({
          feature: feature as string,
          workspace: workspace as string,
          startedAt: startedAt as string,
          memory: Number(memory),
          nanoCpus: Number(nanoCpus),
          ...(execs !== undefined && { execs: Number(execs) }),
          ...(asking === "1" && { asking: true }),
        }),
      );
    } else if (a === "--issue") {
      // Input hygiene: no leading dash or whitespace in what becomes gh's `-R <repo>` (gh is the fake here; `--workspace` refs are unchecked).
      const ref = argv[++i] ?? "";
      if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d+$/.test(ref)) return { bad: a };
      opts.issue = ref;
    } else if (a === "--pr-field") {
      // Only fields that reach no git or Claude call: branch, base, session… do from the allowed wrapper.
      // status is one line, written verbatim, so a newline can't add one of those (SW-549).
      const m = new RegExp(`^(${PR_KEYS})=(.*)$`, "s").exec(argv[++i] ?? "");
      if (
        !m ||
        (m[1] === "status" && LINE_BREAK.test(m[2] ?? "")) ||
        (m[1] === "url" && !PR_URL.test(m[2] ?? ""))
      )
        return { bad: a };
      opts.prFields = { ...opts.prFields, [m[1] as string]: m[2] as string };
    } else if (a === "--pr-line") {
      // Written unquoted, so a test can seed what YAML.stringify would quote (SW-851); --pr-field's keys but status, one line.
      const l = argv[++i] ?? "";
      if (!new RegExp(`^(${PR_LINE_KEYS}): \\S`).test(l) || LINE_BREAK.test(l)) return { bad: a };
      opts.prLines = [...(opts.prLines ?? []), l];
    } else if (a === "--print" && argv[i + 1] !== undefined) print.push(argv[++i] as string);
    else if (
      (a === "--services" ||
        a === "--fragment" ||
        a === "--fragment-change" ||
        a === "--change-base" ||
        a === "--change-branch") &&
      argv[i + 1] !== undefined
    ) {
      const p = argv[++i] as string;
      const file = inside(base, p);
      if (!file || !fs.existsSync(file)) return { bad: a, ...outside(base, p) };
      const keys = {
        "--services": "services",
        "--fragment": "fragment",
        "--fragment-change": "fragmentChange",
        "--change-base": "changeBase",
        "--change-branch": "changeBranch",
      } as const;
      opts[keys[a]] = fs.readFileSync(file, "utf8");
    } else if (a === "--change") {
      // Written under the fixture's code repo: no absolute path, `..` or `.git` can reach outside it or its hooks.
      const p = argv[++i] ?? "";
      // Any part, any case: `./.git/x` and (case-insensitive disk) `.GIT/x` reach the same folder.
      const parts = p.split(/[\\/]/);
      if (
        !p ||
        path.isAbsolute(p) ||
        p.startsWith("-") ||
        parts.some((s) => s === ".." || s.toLowerCase() === ".git")
      )
        return { bad: a };
      opts.change = p;
    } else if ((a === "--workspace" || a === "--config") && argv[i + 1] !== undefined) {
      const p = argv[++i] as string;
      const file = inside(base, p);
      if (!file) return { bad: a, ...outside(base, p) };
      let yml: unknown = null;
      try {
        if (file && fs.existsSync(file)) yml = YAML.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      if (!yml || typeof yml !== "object" || Array.isArray(yml)) return { bad: a };
      opts[a === "--workspace" ? "workspace" : "config"] = yml as Record<string, unknown>;
    } else if (a === "--workflow" && argv[i + 1] !== undefined) {
      const dir = inside(base, argv[++i] as string);
      // Missing: inside(dir, …) would realpath it and throw ENOENT (SW-1167).
      if (dir && !fs.existsSync(dir))
        return { bad: a, file: dir, base: fs.realpathSync(base as string) };
      const yml = dir && inside(dir, "workflow.yaml");
      if (!dir || !yml || !fs.existsSync(yml)) return { bad: a };
      // Resolved before listing: a symlinked stages/ must not list a folder out of the worktree.
      const stages = inside(base, path.join(dir, "stages"));
      if (!stages && fs.existsSync(path.join(dir, "stages"))) return { bad: a };
      const names =
        stages && fs.existsSync(stages)
          ? fs.readdirSync(stages).filter((f) => f.endsWith(".md"))
          : [];
      const files: Record<string, string> = { "workflow.yaml": fs.readFileSync(yml, "utf8") };
      for (const n of names) {
        // Each file again: a symlinked stage file could point out of the worktree.
        const f = inside(base, path.join(dir, "stages", n));
        // A dangling link is not realpath'd by inside(), so it passes and the read would throw (SW-1119).
        if (!f || !fs.existsSync(f)) return { bad: a };
        files[`stages/${n}`] = fs.readFileSync(f, "utf8");
      }
      opts.workflow = { type: path.basename(dir), files };
    } else if (a === "--workflow-in") {
      if (argv[++i] !== "repo") return { bad: a };
      opts.workflowIn = "repo";
    } else break;
  }
  const steps: Step[] = [[]];
  for (let j = i; j < argv.length; j++) {
    const a = argv[j] as string;
    const last = steps.at(-1) as Step;
    if (a === "--then") steps.push([]);
    else if (a === "--then-append") {
      const [target, text] = [argv[j + 1], argv[j + 2]];
      if (target === undefined || text === undefined || !appendable(target))
        return { bad: "--then-append" };
      steps.push({ append: target, text });
      j += 2;
    } else if (Array.isArray(last)) last.push(a);
    // Werkmeister args right after an append, with no --then between them.
    else return { bad: "--then-append" };
  }
  if (opts.workflow && opts.workflowIn) opts.workflow.in = opts.workflowIn;
  return { opts, print, steps };
}

/** A werkmeister step's args, or a `--then-append` edit (SW-1108). */
type Step = string[] | { append: string; text: string };

/**
 * The wrapper is pre-approved, so an edit may reach only text nothing executes: the seeded workflow's
 * files, or markdown in the fixture workspace (never `.git`, where an appended config runs commands).
 */
function appendable(target: string): boolean {
  if (target.startsWith("workflow:"))
    return /^(workflow\.yaml|stages\/[a-z0-9-]+\.md)$/.test(target.slice("workflow:".length));
  const parts = target.split(/[\\/]/);
  return (
    target.endsWith(".md") &&
    !path.isAbsolute(target) &&
    !target.startsWith("-") &&
    !parts.some((s) => s === ".." || s.toLowerCase() === ".git")
  );
}

const runStep = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] as string, ...args], {
      cwd,
      env,
      // A non-TTY stdin makes `workspace init` read fd 0 and hang (SW-323).
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

/** A `--then-append` step: exit 2 when the target is missing or resolves out of the fixture. */
export function append(step: { append: string; text: string }, fx: Fixture): number {
  const inWorkflow = step.append.startsWith("workflow:");
  const rel = inWorkflow ? step.append.slice("workflow:".length) : step.append;
  const file = inside(inWorkflow ? (fx.workflowDir ?? null) : fx.workspace, rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error(`--then-append: ${step.append}: no such file in the fixture`);
    return 2;
  }
  fs.appendFileSync(file, `${step.text}\n`);
  return 0;
}

function show(label: string, file: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(none)\n";
  process.stdout.write(`--- ${label}\n${text}${text.endsWith("\n") ? "" : "\n"}`);
}

export async function run(argv: string[], base = cliWorktree()): Promise<void> {
  const parsed = parse(argv, base);
  if ("bad" in parsed || parsed.steps.some((s) => Array.isArray(s) && s.length === 0)) {
    if ("bad" in parsed)
      console.error(
        "file" in parsed && parsed.file
          ? parsed.bad === "--workflow"
            ? `--workflow: ${parsed.file} is not a folder (resolved against ${parsed.base}, the worktree of the running CLI): pass a folder under it holding workflow.yaml`
            : `${parsed.bad}: a file under the worktree; ${parsed.file} is not under ${parsed.base} (the worktree, as this process sees it): pass it relative to the worktree`
          : parsed.bad === "--then-append"
            ? "--then-append <path> <text>: after a werkmeister step, followed by --then or the end; <path> an existing .md in the fixture workspace (no .git), or workflow:workflow.yaml / workflow:stages/<name>.md"
            : parsed.bad === "--workflow"
              ? "--workflow: a folder under the worktree holding workflow.yaml (and stages/*.md)"
              : parsed.bad === "--workflow-in"
                ? "--workflow-in: only repo (the default is the temp HOME)"
                : parsed.bad === "--pr-field"
                  ? "--pr-field: skip_release, skip_exercise, skip_review, release, status (one line) or url (https://github.com/o/<repo>/pull/<n>) =<value>, with --gate"
                  : parsed.bad === "--pr-line"
                    ? '--pr-line: one raw line "<key>: <value>", key skip_release, skip_exercise, skip_review or release (status: --pr-field), with --gate'
                    : parsed.bad === "--issue"
                      ? "--issue: a GitHub issue as owner/repo#number, e.g. o/app#1"
                      : parsed.bad === "--change"
                        ? "--change: a path inside the code repo, e.g. plugins/x/y.ts"
                        : parsed.bad === "--running"
                          ? "--running: a file under the worktree, one feature<TAB>workspace<TAB>startedAt<TAB>memoryBytes<TAB>nanoCpus[<TAB>execs[<TAB>asking 0|1]] line per container"
                          : `${parsed.bad}: a file under the worktree${parsed.bad === "--workspace" || parsed.bad === "--config" ? ", holding a YAML mapping" : ""}`,
      );
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const {
    opts: { workflowIn, ...opts },
    print,
    steps,
  } = parsed;
  let seed: ReturnType<typeof fixturePreset>;
  try {
    if (workflowIn && !opts.workflow) throw new Error("--workflow-in needs --workflow");
    if (!opts.workflow && steps.some((s) => !Array.isArray(s) && s.append.startsWith("workflow:")))
      throw new Error("--then-append workflow:<path> needs --workflow");
    seed = fixturePreset({ ...opts, daemon: undefined, jira: undefined });
    // Only --gate seeds a PR file, so the fields would otherwise vanish silently.
    if (opts.prFields && !seed.prFile) throw new Error("--pr-field needs --gate");
    if (opts.prLines && !seed.prFile) throw new Error("--pr-line needs --gate");
    // Both shape the change --gate's PR file gates; without one they would go unexercised.
    if ((opts.change || opts.fragmentChange !== undefined) && !opts.gate)
      throw new Error("--change and --fragment-change need --gate");
    if (opts.staleCompose && opts.fragmentChange === undefined)
      throw new Error("--stale-compose needs --fragment-change");
    if ((opts.changeBase !== undefined || opts.changeBranch !== undefined) && !opts.change)
      throw new Error("--change-base and --change-branch need --change");
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-fixture-")));
  const daemon = opts.daemon ? await startFakeDaemon() : null;
  const jira = opts.jira ? await startFakeJira() : null;
  try {
    const fx = seedFixture(root, { ...seed, daemon: daemon?.url, jira: jira?.url });
    const env = {
      ...process.env,
      ...fx.env,
      // This build's own root, never one the shell exported (the main checkout's, say).
      WERKMEISTER_ROOT: path.resolve(path.dirname(process.argv[1] as string), ".."),
    };
    let code = 0;
    // compose.yml from the base fragment, then the branch's lands: a workspace inited before its change (SW-817).
    if (fx.applyFragmentChange) {
      code = await runStep(["workspace", "init", "--no-build"], fx.workspace, env);
      if (code === 0) fx.applyFragmentChange();
    }
    for (const step of code === 0 ? steps : []) {
      // Close-out deletes the workspace folder; a later step runs from the fixture root (SW-1126).
      const cwd = fs.existsSync(fx.workspace) ? fx.workspace : fx.root;
      code = Array.isArray(step) ? await runStep(step, cwd, env) : append(step, fx);
      if (code !== 0) break;
    }
    for (const p of print) {
      const file = inside(fx.workspace, p);
      if (file) show(p, file);
      else process.stdout.write(`--- ${p}\n(outside the fixture workspace; not printed)\n`);
    }
    show("gh calls", fx.ghLog);
    show("docker calls", fx.dockerLog);
    if (daemon)
      process.stdout.write(
        `--- daemon calls\n${daemon.calls.map((c) => `${c}\n`).join("") || "(none)\n"}`,
      );
    if (jira)
      process.stdout.write(
        `--- jira calls\n${jira.calls.map((c) => `${c}\n`).join("") || "(none)\n"}`,
      );
    process.exitCode = code;
  } finally {
    await daemon?.close();
    await jira?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
