/**
 * werkmeister internal fixture [--gate] [--bare] [--services <file>] [--print <file>]... <args> [--then <args>]...
 *
 * What `.werkmeister/bin/with-fixture-workspace` runs (SW-292): seeds a fixture in a temp folder,
 * runs this same build with each `<args>` from the fixture workspace (stopping at the first
 * failure), prints each `--print` file and the fake gh/docker calls, then deletes the folder.
 * main.ts hands it raw argv, so a werkmeister flag like `--services` never reaches commander here.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { seedFixture } from "werkmeister-core/fixture_workspace";

const USAGE =
  "usage: with-fixture-workspace [--no-wait] [--gate] [--bare] [--services <file>] [--print <file>]... <werkmeister args> [--then <werkmeister args>]...";

function parse(argv: string[]) {
  const opts = { gate: false, bare: false, services: undefined as string | undefined };
  const print: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") opts.gate = true;
    else if (a === "--bare") opts.bare = true;
    else if ((a === "--services" || a === "--print") && argv[i + 1] !== undefined) {
      const v = argv[++i] as string;
      if (a === "--print") print.push(v);
      else opts.services = fs.readFileSync(v, "utf8");
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
  const { opts, print, steps } = parse(argv);
  if (steps.some((s) => s.length === 0)) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "werkmeister-fixture-")));
  try {
    const fx = seedFixture(root, opts);
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const env = {
      ...process.env,
      ...fx.env,
      HOME: home,
      // This build's own root, never one the shell exported (the main checkout's, say).
      WERKMEISTER_ROOT: path.resolve(path.dirname(process.argv[1] as string), ".."),
    };
    let code = 0;
    for (const step of steps) {
      code = await runStep(step, fx.workspace, env);
      if (code !== 0) break;
    }
    for (const p of print) show(p, path.resolve(fx.workspace, p));
    show("gh calls", fx.ghLog);
    show("docker calls", fx.dockerLog);
    process.exitCode = code;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
