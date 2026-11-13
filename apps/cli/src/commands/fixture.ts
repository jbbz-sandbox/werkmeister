/**
 * werkmeister internal fixture [--gate] [--bare] [--daemon] [--exec-runs] [--merged] [--behind] [--slots-full] [--issue <ref>] [--pr-field <key>=<value>]... [--workspace <file>] [--services <file>] [--fragment <file>] [--change <path>] [--fragment-change <file>] [--print <file>]... <args> [--then <args>]...
 *
 * What `.werkmeister/bin/with-fixture-workspace` runs (SW-292): seeds a fixture in a temp folder,
 * runs this same build with each `<args>` from the fixture workspace (stopping at the first
 * failure), prints each `--print` file and the fake gh/docker (and, with --daemon, daemon) calls,
 * then deletes the folder.
 * main.ts hands it raw argv, so a werkmeister flag like `--services` never reaches commander here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startFakeDaemon } from "werkmeister-core/fixture_fakes";
import { fixturePreset, seedFixture } from "werkmeister-core/fixture_workspace";
import YAML from "yaml";

const USAGE =
  "usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--daemon] [--exec-runs] [--merged] [--behind] [--slots-full] [--issue <ref>] [--pr-field <key>=<value>]... [--workspace <file>] [--services <file>] [--fragment <file>] [--change <path>] [--fragment-change <file>] [--print <file>]... <werkmeister args> [--then <werkmeister args>]...\n(fixture options come first: the first other argument starts the werkmeister args)";

/**
 * *p* resolved under *base*, real path, or null when it escapes it (absolute, `..`, a symlink out).
 * The wrapper is pre-approved, so it must not read or print files outside the fixture (or, for
 * --services, outside the caller's folder).
 */
export function inside(base: string, p: string): string | null {
  const b = fs.realpathSync(base);
  let r = path.resolve(b, p);
  if (fs.existsSync(r)) r = fs.realpathSync(r);
  return r.startsWith(b + path.sep) ? r : null;
}

export function parse(argv: string[]) {
  const opts = {
    gate: false,
    bare: false,
    daemon: false,
    execRuns: false,
    merged: false,
    behind: false,
    slotsFull: false,
    issue: undefined as string | undefined,
    prFields: undefined as Record<string, string> | undefined,
    services: undefined as string | undefined,
    fragment: undefined as string | undefined,
    fragmentChange: undefined as string | undefined,
    change: undefined as string | undefined,
    workspace: undefined as Record<string, unknown> | undefined,
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
    else if (a === "--issue") {
      // Input hygiene: no leading dash or whitespace in what becomes gh's `-R <repo>` (gh is the fake here; `--workspace` refs are unchecked).
      const ref = argv[++i] ?? "";
      if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d+$/.test(ref)) return { bad: a };
      opts.issue = ref;
    } else if (a === "--pr-field") {
      // Only fields that reach no git or Claude call: branch, base, session… do from the allowed wrapper.
      // status is one line, written verbatim, so a newline can't add one of those (SW-549).
      const m = /^(skip_release|skip_exercise|skip_review|release|status)=(.*)$/s.exec(
        argv[++i] ?? "",
      );
      if (!m || (m[1] === "status" && /[\r\n\u2028\u2029\u0085]/.test(m[2] ?? "")))
        return { bad: a };
      opts.prFields = { ...opts.prFields, [m[1] as string]: m[2] as string };
    } else if (a === "--print" && argv[i + 1] !== undefined) print.push(argv[++i] as string);
    else if (
      (a === "--services" || a === "--fragment" || a === "--fragment-change") &&
      argv[i + 1] !== undefined
    ) {
      const file = inside(process.cwd(), argv[++i] as string);
      if (!file || !fs.existsSync(file)) return { bad: a };
      const key =
        a === "--services" ? "services" : a === "--fragment" ? "fragment" : "fragmentChange";
      opts[key] = fs.readFileSync(file, "utf8");
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
    } else if (a === "--workspace" && argv[i + 1] !== undefined) {
      const file = inside(process.cwd(), argv[++i] as string);
      let yml: unknown = null;
      try {
        if (file && fs.existsSync(file)) yml = YAML.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      if (!yml || typeof yml !== "object" || Array.isArray(yml)) return { bad: a };
      opts.workspace = yml as Record<string, unknown>;
    } else break;
  }
  const steps: string[][] = [[]];
  for (const a of argv.slice(i)) {
    if (a === "--then") steps.push([]);
    else (steps.at(-1) as string[]).push(a);
  }
  return { opts, print, steps };
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

function show(label: string, file: string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "(none)\n";
  process.stdout.write(`--- ${label}\n${text}${text.endsWith("\n") ? "" : "\n"}`);
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if ("bad" in parsed || parsed.steps.some((s) => s.length === 0)) {
    if ("bad" in parsed)
      console.error(
        parsed.bad === "--pr-field"
          ? "--pr-field: skip_release, skip_exercise, skip_review, release or status (one line) =<value>, with --gate"
          : parsed.bad === "--issue"
            ? "--issue: a GitHub issue as owner/repo#number, e.g. o/app#1"
            : parsed.bad === "--change"
              ? "--change: a path inside the code repo, e.g. plugins/x/y.ts"
              : `${parsed.bad}: a file under the current folder${parsed.bad === "--workspace" ? ", holding a YAML mapping" : ""}`,
      );
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const { opts, print, steps } = parsed;
  let seed: ReturnType<typeof fixturePreset>;
  try {
    seed = fixturePreset({ ...opts, daemon: undefined });
    // Only --gate seeds a PR file, so the fields would otherwise vanish silently.
    if (opts.prFields && !seed.prFile) throw new Error("--pr-field needs --gate");
    // Both shape the change --gate's PR file gates; without one they would go unexercised.
    if ((opts.change || opts.fragmentChange !== undefined) && !opts.gate)
      throw new Error("--change and --fragment-change need --gate");
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-fixture-")));
  const daemon = opts.daemon ? await startFakeDaemon() : null;
  try {
    const fx = seedFixture(root, { ...seed, daemon: daemon?.url });
    const env = {
      ...process.env,
      ...fx.env,
      // This build's own root, never one the shell exported (the main checkout's, say).
      WERKMEISTER_ROOT: path.resolve(path.dirname(process.argv[1] as string), ".."),
    };
    let code = 0;
    for (const step of steps) {
      code = await runStep(step, fx.workspace, env);
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
    process.exitCode = code;
  } finally {
    await daemon?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
