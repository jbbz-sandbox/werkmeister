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
import { dotDir } from "./dot_dir.js";
import { SandboxError } from "./errors.js";
import { loadFeatureRouters } from "./feature_routing.js";
import { ProcError, run, runAsync } from "./proc.js";
import { info, passthrough, raw, success, warn } from "./reporter.js";
import { getSlot } from "./slots.js";

/**
 * The Playwright release `werkmeister machine setup` downloads Chromium for. Each release
 * expects one exact browser build, so a workspace on another version finds no
 * browser.
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
 * There is deliberately no fallback to the werkmeister root: running whatever suite
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
 * `WERKMEISTER_FEATURE` (and `SANDBOX_FEATURE`, until suites move) is what the project's playwright config reads to attach the
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
    warn("Start it first with: werkmeister feature up " + feature);
    warn("Running tests anyway with feature header routing...");
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    WERKMEISTER_FEATURE: feature,
    SANDBOX_FEATURE: feature,
  };
  if (slot) {
    env["WERKMEISTER_SLOT"] = String(slot);
  }

  info(`Working directory: ${cwd}`);
  const installed = installedPlaywrightVersion(cwd);
  if (installed !== PLAYWRIGHT_VERSION) {
    warn(
      `@playwright/test is ${installed ?? "not installed"} here, but \`werkmeister machine setup\` ` +
        `installs Chromium for ${PLAYWRIGHT_VERSION} -- the browser may be missing. ` +
        `Fix with: npm install -D @playwright/test@${PLAYWRIGHT_VERSION}`,
    );
  }
  info(`WERKMEISTER_FEATURE=${feature}`);

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

// ---------------------------------------------------------------------------
// Scaffolding a suite (`werkmeister feature test --scaffold`, the feature-test skill)
// ---------------------------------------------------------------------------

export interface FeatureIngress {
  baseUrl: string;
  /** Where the spec sets its X-Feature cookie: the host's parent domain. */
  cookieDomain: string;
}

/**
 * The ingress URL a scaffolded suite targets. Derived like the Caddyfile's
 * hosts -- the first service with a `feature_router:` block -- so it follows
 * whatever `werkmeister machine setup` configured; an explicit *baseUrl* wins.
 */
export function featureIngress(baseUrl?: string | null): FeatureIngress {
  if (!baseUrl) {
    const host = Object.values(loadFeatureRouters()).find((r) => r.hostname)?.hostname;
    if (!host) {
      throw new SandboxError(
        "No service declares a feature_router: block in services.yaml. Add one, or pass --base-url.",
        "NO_FEATURE_ROUTER",
      );
    }
    baseUrl = `https://${host}`;
  }
  const host = new URL(baseUrl).hostname;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    cookieDomain: `.${host.split(".").slice(1).join(".")}`,
  };
}

const playwrightConfig = (
  baseUrl: string,
) => `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  use: {
    // Filled by \`werkmeister feature test --scaffold\` from the configured feature ingress.
    baseURL: '${baseUrl}',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'X-Feature': process.env.WERKMEISTER_FEATURE || '',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;

const featureSpec = (feature: string, { baseUrl, cookieDomain }: FeatureIngress) =>
  `import { test, expect } from '@playwright/test';

const FEATURE = process.env.WERKMEISTER_FEATURE!;

// Filled by \`werkmeister feature test --scaffold\` from the configured feature ingress.
const BASE_URL = '${baseUrl}';

test('feature: ${feature}', async ({ page, context }) => {
  // Set the feature cookie so routing works at the browser level
  await context.addCookies([{
    name: 'X-Feature',
    value: FEATURE,
    domain: '${cookieDomain}',
    path: '/',
    maxAge: 2592000,
  }]);

  await page.goto('/');

  // TODO: Add assertions specific to your feature
  await expect(page).toHaveURL(\`\${BASE_URL}/\`);

  // Pause here — Playwright Inspector opens so you can interact with the browser.
  // Close the inspector or press Resume when done.
  await page.pause();
});
`;

/**
 * Write `playwright.config.ts` and `<feature>.spec.ts` into *workspace*,
 * skipping any that already exist. Returns the paths it created.
 */
export function scaffoldFeatureTests(
  feature: string,
  workspace: string,
  ingress: FeatureIngress,
): string[] {
  // The name becomes a filename; a separator would write outside the workspace.
  if (path.basename(feature) !== feature) {
    throw new SandboxError(`Invalid feature name: ${feature}`, "BAD_FEATURE_NAME");
  }
  const files: [string, string][] = [
    ["playwright.config.ts", playwrightConfig(ingress.baseUrl)],
    [`${feature}.spec.ts`, featureSpec(feature, ingress)],
  ];
  const created: string[] = [];
  for (const [name, text] of files) {
    const dest = path.join(workspace, name);
    if (fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, text);
    created.push(dest);
  }
  return created;
}

/** Install the pinned `@playwright/test` if absent; never replace a project's own version. */
export function ensurePlaywright(workspace: string): void {
  const installed = installedPlaywrightVersion(workspace);
  if (installed === PLAYWRIGHT_VERSION) {
    info(`@playwright/test ${installed} present`);
    return;
  }
  if (installed) {
    warn(
      `workspace pins @playwright/test ${installed}, but \`werkmeister machine setup\` installs Chromium ` +
        `for ${PLAYWRIGHT_VERSION} -- if launch fails, run: npx playwright@${installed} install chromium`,
    );
    return;
  }
  // Spec imports resolve from the workspace, so `npx` alone cannot supply the package.
  const cmd = ["npm", "install", "--save-dev", `@playwright/test@${PLAYWRIGHT_VERSION}`];
  // resolveWorkspace can land on the workspaces root (a workspace is itself a
  // git repo); never drop a package.json + node_modules there.
  if (!fs.existsSync(dotDir(workspace))) {
    throw new SandboxError(
      `${workspace} is not a workspace (no ${path.basename(dotDir(workspace))}/) -- ` +
        `pass --workspace, or install manually there: ${cmd.join(" ")}`,
      "NOT_A_WORKSPACE",
    );
  }
  const live = passthrough();
  let result: { status: number; stderr: string };
  try {
    result = run(cmd, { cwd: workspace, ...(live ? {} : { capture: true }) });
  } catch (e) {
    result = { status: 127, stderr: e instanceof Error ? e.message : String(e) };
  }
  if (result.status !== 0) {
    if (!live && result.stderr) raw(result.stderr, "stderr");
    throw new SandboxError(`\`${cmd.join(" ")}\` failed in ${workspace}`, "PLAYWRIGHT_INSTALL");
  }
  success(`installed @playwright/test ${PLAYWRIGHT_VERSION}`);
}
