/**
 * Running a feature's Playwright suite.
 *
 * The suite is a child process that can run for minutes, so it goes through
 * `runAsync` rather than `proc.run`: a caller that is not a dying CLI process
 * needs a way to stop it. A failing suite is a *result*, not a fault — it comes
 * back in `status` for the caller to map to an exit code — but a missing `npx`
 * or a timeout is a thrown `SandboxError`.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { candidateServiceNames, validationRows } from "./archetypes.js";
import { loadArchetypes, loadReposConfig, loadServices } from "./config.js";
import { SandboxError } from "./errors.js";
import { loadFeatureRouters } from "./feature_routing.js";
import { ProcError, runAsync } from "./proc.js";
import { info, passthrough, raw, warn } from "./reporter.js";
import { getSlot } from "./slots.js";

/**
 * The Playwright release `sandbox setup` downloads Chromium for. Each release
 * expects one exact browser build, so a workspace on another version finds no
 * browser. Mirrored in the werkmeister plugin's feature-test setup_feature.py, which
 * ships separately and cannot import this; a parity test keeps them equal.
 */
export const PLAYWRIGHT_VERSION = "1.63.0";

/** Ten minutes, matching what the CLI has always allowed a suite. */
const TEST_TIMEOUT_SECONDS = 600;

const CONFIG_NAMES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"];

/** The workspace root plus each repo worktree directly under it. */
export function playwrightSearchDirs(workspace: string): string[] {
  const dirs = [workspace];
  try {
    for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(workspace, entry.name, ".git"))) {
        dirs.push(path.join(workspace, entry.name));
      }
    }
  } catch {
    // An unreadable workspace has no suite; the caller reports that.
  }
  return dirs;
}

/**
 * The first of *dirs* holding a playwright config, or null when none does.
 *
 * Separated out because it is the one decision here worth testing on its own.
 * There is deliberately no fallback to the sandbox root: running whatever suite
 * lives there (or none) against an unrelated workspace reports success either
 * way, which is the false green this guards against.
 */
export function playwrightCwd(dirs: string[]): string | null {
  for (const dir of dirs) {
    if (!(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
      continue;
    }
    if (CONFIG_NAMES.some((name) => fs.existsSync(path.join(dir, name)))) {
      return dir;
    }
  }
  return null;
}

/**
 * What to say when the workspace has no Playwright suite: the per-service
 * guidance that does apply, so a caller is not left with only "nothing ran".
 */
export function noSuiteMessage(workspace: string): string {
  const repoNames = playwrightSearchDirs(workspace)
    .slice(1)
    .map((d) => path.basename(d));
  let services = "";
  try {
    services =
      /^SERVICES=(.*)$/m.exec(fs.readFileSync(path.join(workspace, ".env"), "utf8"))?.[1] ?? "";
  } catch {
    // No .env: fall back to the repos' services.
  }
  const selected = services
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const servicesConfig = loadServices();
  const routers = loadFeatureRouters(servicesConfig);
  const rows = validationRows(
    candidateServiceNames(repoNames, loadReposConfig(), selected),
    servicesConfig,
    loadArchetypes(),
    new Set(Object.keys(routers)),
  );
  const lines = rows.map(
    (r) => `  - ${r.service} — test: ${r.test ?? "—"} — validate: ${r.validate}`,
  );
  return (
    "No Playwright suite found for this workspace (no playwright.config.{ts,js,mjs} in the workspace root or a repo worktree), so nothing was run." +
    (lines.length ? `\nValidate each service as follows:\n${lines.join("\n")}` : "")
  );
}

/** The `@playwright/test` version *cwd* resolves (hoisting included), or null if none. */
export function installedPlaywrightVersion(cwd: string): string | null {
  try {
    const pkg = createRequire(path.join(cwd, "package.json")).resolve(
      "@playwright/test/package.json",
    );
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

export interface TestRunArgs {
  feature: string;
  workspace: string;
  extraArgs?: string[];
  signal?: AbortSignal;
}

export interface TestRunResult {
  status: number;
  /** null when no suite was found and nothing ran. */
  cwd: string | null;
  /** Set only when nothing ran; says why and what to do instead. */
  message?: string;
  slot: number | null;
}

/**
 * Run the Playwright suite for *feature*.
 *
 * `SANDBOX_FEATURE` is what the project's playwright config reads to attach the
 * `X-Feature` cookie, so it is set whether or not a slot exists — a feature
 * with no slot still routes by header, which is why the CLI warns rather than
 * refusing.
 */
export async function runFeatureTests({
  feature,
  workspace,
  extraArgs = [],
  signal,
}: TestRunArgs): Promise<TestRunResult> {
  const slot = await getSlot(feature);
  const cwd = playwrightCwd(playwrightSearchDirs(workspace));
  if (cwd === null) {
    return { status: 1, cwd, slot, message: noSuiteMessage(workspace) };
  }
  if (slot === null) {
    // Not a refusal: routing still works by header, so the suite is worth
    // running -- the caller just needs to know why nothing is on a slot port.
    warn(`Feature '${feature}' does not have an allocated slot`);
    warn("Start it first with: sandbox up " + feature);
    warn("Running tests anyway with feature header routing...");
  }

  const env: NodeJS.ProcessEnv = { ...process.env, SANDBOX_FEATURE: feature };
  if (slot) {
    env["SANDBOX_SLOT"] = String(slot);
  }

  info(`Working directory: ${cwd}`);
  const installed = installedPlaywrightVersion(cwd);
  if (installed !== PLAYWRIGHT_VERSION) {
    warn(
      `@playwright/test is ${installed ?? "not installed"} here, but \`sandbox setup\` ` +
        `installs Chromium for ${PLAYWRIGHT_VERSION} -- the browser may be missing. ` +
        `Fix with: npm install -D @playwright/test@${PLAYWRIGHT_VERSION}`,
    );
  }
  info(`SANDBOX_FEATURE=${feature}`);

  const cmd = ["npx", "playwright", "test", ...extraArgs];
  info(`Running: ${cmd.join(" ")}`);
  raw("\n");

  // A terminal caller watches Playwright live through inherited stdio. An
  // in-process one owns no TTY -- its stdout may be an MCP transport -- so
  // capture and replay through the reporter instead, which is also the only
  // way the output reaches a tool result at all.
  const live = passthrough();
  try {
    const result = await runAsync(cmd, {
      env,
      cwd,
      timeout: TEST_TIMEOUT_SECONDS,
      signal,
      ...(live ? {} : { capture: true }),
    });
    if (!live) {
      if (result.stdout) raw(result.stdout);
      if (result.stderr) raw(result.stderr, "stderr");
    }
    return { status: result.status, cwd, slot };
  } catch (e) {
    // A timeout or abort makes runAsync reject instead of resolve, so the
    // output captured above never runs -- but it still lives on the
    // ProcError. Replay it here, or a 10-minute run that times out reports
    // an empty transcript on exactly the failure where it matters most. The
    // TTY path (`live`) already streamed to the inherited stdio, so skip it
    // there to avoid printing the output twice.
    if (!live && e instanceof ProcError) {
      if (e.stdout) raw(e.stdout);
      if (e.stderr) raw(e.stderr, "stderr");
    }
    if (e instanceof ProcError && e.code === "ENOENT") {
      throw new SandboxError(
        "npx not found. Ensure Node.js is installed and npx is on your PATH.\n" +
          "       You may also need to run: npm install -D @playwright/test",
        "NPX_MISSING",
      );
    }
    if (e instanceof ProcError && e.code === "ETIMEDOUT") {
      throw new SandboxError("Playwright tests timed out after 10 minutes", "TEST_TIMEOUT");
    }
    throw e;
  }
}
