/**
 * werkmeister internal fixture [--gate] [--bare] [--daemon] [--services <file>] [--fragment <file>] [--print <file>]... <args> [--then <args>]...
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

const USAGE =
  "usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--daemon] [--services <file>] [--fragment <file>] [--print <file>]... <werkmeister args> [--then <werkmeister args>]...\n(fixture options come first: the first other argument starts the werkmeister args)";

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

function parse(argv: string[]) {
  const opts = {
    gate: false,
    bare: false,
    daemon: false,
    services: undefined as string | undefined,
    fragment: undefined as string | undefined,
  };
  const print: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") opts.gate = true;
    else if (a === "--bare") opts.bare = true;
    else if (a === "--daemon") opts.daemon = true;
    else if (a === "--print" && argv[i + 1] !== undefined) print.push(argv[++i] as string);
    else if ((a === "--services" || a === "--fragment") && argv[i + 1] !== undefined) {
      const file = inside(process.cwd(), argv[++i] as string);
      if (!file || !fs.existsSync(file)) return { bad: a };
      opts[a === "--services" ? "services" : "fragment"] = fs.readFileSync(file, "utf8");
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
    if ("bad" in parsed) console.error(`${parsed.bad}: a file under the current folder`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const { opts, print, steps } = parsed;
  let seed: ReturnType<typeof fixturePreset>;
  try {
    seed = fixturePreset({ ...opts, daemon: undefined });
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
