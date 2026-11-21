/**
 * werkmeister internal branch-cli <werkmeister args>
 *
 * SW-555: runs this workspace's werkmeister worktree build (`apps/cli/dist/main.js`) from the host,
 * against the workspace's real containers. main.ts hands it raw argv, so the args never meet commander.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { containerOf, sandboxRoot } from "werkmeister-core/config";
import { gitEnv } from "werkmeister-core/proc";
import { repoDirs } from "werkmeister-core/standards";
import { findWorkspaceRoot } from "werkmeister-core/workspace_init";

// Branch code runs with the real ~/.werkmeister, so only verbs scoped to this workspace: no daemon, machine or infra.
const ALLOWED = ["pr gate", "feature up", "feature stop", "feature status"];

function refuse(message: string): void {
  console.error(`branch-cli: ${message}`);
  process.exitCode = 2;
}

export async function run(argv: string[]): Promise<void> {
  if (!ALLOWED.includes(argv.slice(0, 2).join(" ")))
    return refuse(
      `runs only ${ALLOWED.map((v) => `\`${v}\``).join(", ")}; got \`${argv.join(" ")}\``,
    );
  const ws = findWorkspaceRoot();
  const wt = repoDirs(ws).find((d) => fs.existsSync(path.join(d, "apps", "cli", "werkmeister")));
  if (!wt) return refuse(`no werkmeister worktree in ${ws}`);
  const main = path.join(wt, "apps", "cli", "dist", "main.js");
  if (!fs.existsSync(main)) {
    let env = "";
    try {
      env = fs.readFileSync(path.join(ws, ".env"), "utf8");
    } catch {}
    const feature = /^FEATURE=(.+)$/m.exec(env)?.[1]?.trim() ?? "<feature>";
    return refuse(
      `${main} is not built. Build it in the container: ` +
        `docker exec -w /app ${containerOf(feature, "werkmeister-core")} pnpm turbo run build --filter=werkmeister`,
    );
  }
  let head = "?";
  try {
    head = execFileSync("git", ["-C", wt, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      env: gitEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  console.error(`branch-cli: running ${main} (worktree at ${head})`);

  const root = sandboxRoot();
  const nodePath = [path.join(root, "node_modules"), process.env.NODE_PATH].filter(Boolean);
  const env = {
    ...process.env,
    // The installed root, not the worktree: sandboxRoot() also places the shared Caddy and k8s-forwards.
    WERKMEISTER_ROOT: root,
    // shortcut: dockerode resolves from the installed CLI, so a branch that bumps dockerode runs main's copy; upgrade if a branch needs its own.
    NODE_PATH: nodePath.join(path.delimiter),
    WERKMEISTER_BRANCH_CLI: "1",
  };
  process.exitCode = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [main, ...argv], { stdio: "inherit", env });
    child.on("error", () => resolve(1));
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
