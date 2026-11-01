/**
 * Child processes under a GUI app's minimal PATH: the augmented env, the
 * `gh`/`docker` overrides, and {@link runCapture}. The `claude` CLI on top of
 * this lives in harness/claude/cli.ts (SW-187).
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { envVar, isFixture } from "./config.js";
import { SandboxError, WORKSPACE_ERROR_CODE } from "./errors.js";

export function stripAnsi(s: string): string {
  return stripVTControlCharacters(s);
}

export async function isExecutable(p: string): Promise<boolean> {
  try {
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Env for a child `werkmeister` process. The wrapper has to find a `node` runtime
 * (and `docker`, `git`, `gh` downstream of it), which the stripped PATH a
 * GUI-launched process inherits often can't — prepend the usual tool dirs.
 * Those dirs beat a fake earlier on PATH, so fake gh/docker through {@link toolBin}'s overrides.
 *
 * Exported for the same reason as {@link sandbox.resolveSandboxBin}: callers that spawn // name-check: ignore
 * the CLI themselves need this env, not a hand-rolled approximation of it.
 */
export function childEnv(): NodeJS.ProcessEnv {
  const extra = [
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  const merged = [...new Set([...extra, ...current])].join(path.delimiter);
  return { ...process.env, PATH: merged };
}

/** `gh`, or $WERKMEISTER_GH_BIN (tests point it at a fake); under WERKMEISTER_FIXTURE a stub that fails (SW-177). */
export const ghBin = () => envVar("GH_BIN") || (isFixture() ? fixtureGhStub() : "gh");

/** `docker`, or $WERKMEISTER_DOCKER_BIN (tests and fixture exercises point it at a fake; SW-208). */
export const dockerBin = () => envVar("DOCKER_BIN") || "docker";

/** *bin*, with `gh` and `docker` resolved through their overrides: childEnv()'s PATH would beat a fake (SW-148, SW-208). */
export const toolBin = (bin: string): string =>
  bin === "gh" ? ghBin() : bin === "docker" ? dockerBin() : bin;

let ghStub: string | null = null;
function fixtureGhStub(): string {
  if (ghStub) return ghStub;
  const file = path.join(os.tmpdir(), `werkmeister-fixture-gh-${process.pid}`);
  writeFileSync(file, '#!/bin/sh\necho "gh called under WERKMEISTER_FIXTURE: $*" >&2\nexit 1\n', {
    mode: 0o755,
  });
  ghStub = file;
  return file;
}

/**
 * Run a binary, capturing stdout/stderr, with stdin CLOSED so `claude -p`
 * doesn't stall 3s waiting for piped input. Rejects on spawn error or timeout.
 * `"gh"` and `"docker"` resolve through {@link toolBin}.
 */
export function runCapture(
  bin: string,
  args: string[],
  cwd: string = os.homedir(),
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(toolBin(bin), args, {
      cwd,
      env: childEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new SandboxError("The `claude` CLI timed out after 120s.", WORKSPACE_ERROR_CODE));
    }, 120_000);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

/** Wrap a value in single quotes for a POSIX shell, escaping embedded quotes. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
