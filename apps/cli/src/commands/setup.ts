/**
 * sandbox setup [--check] [--yes]
 *
 * The guided first-run (and re-run) of a sandbox machine. Walks through every
 * prerequisite that lives outside the checkout, writing the machine-global
 * config in `~/.sandbox` and converging the rest:
 *
 * The wizard asks everything up front, in seven sections:
 *
 *   1. paths        — repos root and workspaces root (`paths:` in config.yaml)
 *   2. browser      — which browser `sandbox open` launches (`overrides.browser`)
 *   3. ingress      — base domains + cert directory (`ingress:`)
 *   4. registry     — how to create services.yaml, if it doesn't exist yet
 *   5. jira         — OPTIONAL REST credentials for the dashboard fast path
 *   6. telepresence — OPTIONAL OSS client, via Homebrew
 *   7. superpowers  — OPTIONAL plugin, installed alongside ponytail
 *
 * then writes the config and converges the machine (lib/machine_setup):
 * seeding the `~/.sandbox` registry files (or migrating them up from a legacy
 * `infra/config/` checkout), the sandbox-tools and ponytail plugins, the
 * companion sandbox-workspace checkout, the TLS certificate covering every
 * routed hostname, and the three optional prerequisites above.
 *
 * Every step is idempotent, so re-running after adding a service or changing a
 * domain converges just what changed. Nothing is written before the last
 * question is answered — Ctrl-C at any prompt leaves the machine untouched.
 *
 *   sandbox setup            # interactive wizard
 *   sandbox setup --check    # report only; no prompts, no writes, nonzero on drift
 *   sandbox setup --yes      # non-interactive; accept defaults, skip optional installs
 *
 * `--check` and `--yes` never prompt, so both are safe in CI. Plugin changes
 * reach only NEW Claude Code sessions — a running session keeps the plugin
 * snapshot it launched with.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BROWSER_PROMPT, BROWSERS, DEFAULT_BROWSER } from "../lib/browser.js";
import { Colors, getSandboxRoot, info, success, warn } from "../lib/config.js";
import { ingressHostnames } from "../lib/feature_routing.js";
import * as gc from "../lib/global_config.js";
import type { PromptSpec } from "../lib/global_config.js";
import { LEGACY_CONFIG_DIR, runSetup, type Step } from "../lib/machine_setup.js";
import { prompt, runWizard } from "../lib/wizard.js";

// Migration source (currently-exported env) for each path prompt, so an
// existing machine migrates by pressing Enter through the wizard.
const _ENV_FOR: Record<string, string> = {
  repos_root: "SANDBOX_REPOS_ROOT",
  workspaces_root: "SANDBOX_WORKSPACES_ROOT",
};

function builtinDefault(key: string): string {
  const home = os.homedir();
  const table: Record<string, string> = {
    repos_root: path.join(home, "workspace"),
    workspaces_root: path.join(home, "workspace", "features"),
  };
  return table[key] ?? "";
}

/** Ask a yes/no question; *fallback* is used verbatim when not interactive. */
async function confirm(label: string, fallback: boolean, interactive: boolean): Promise<boolean> {
  if (!interactive) {
    return fallback;
  }
  const answer = await prompt(`${label} [y/n]`, fallback ? "y" : "n");
  return /^y/i.test(answer.trim());
}

function heading(text: string): void {
  console.log(`\n${Colors.BOLD}${text}${Colors.RESET}`);
}

/** What the wizard collected, handed to `runSetup` as options. */
interface Answers {
  demo: boolean;
  k8sContext: string;
  installTelepresence: boolean;
  installOptionalPlugins: boolean;
  skipSudo: boolean;
}

/**
 * Collect config answers and persist `~/.sandbox/config.yaml` + its projections.
 *
 * Returns the setup-step answers that are NOT stored in the YAML (one-shot
 * choices like "seed the demo registry" or "install telepresence").
 */
async function configureMachine(interactive: boolean): Promise<Answers> {
  const cfg = gc.load();
  const paths = cfg.paths ?? {};
  const currentIngress = gc.loadIngress(cfg);

  // --- 1. paths -----------------------------------------------------------
  heading("1. Paths");
  const resolvedPaths: Record<string, string> = {};
  const pathDefault = (spec: PromptSpec): string =>
    paths[spec.key] || process.env[_ENV_FOR[spec.key]] || builtinDefault(spec.key);

  if (interactive) {
    await runWizard(gc._CONFIG_PROMPTS, resolvedPaths, pathDefault, {
      intro: "Where your repos and per-feature workspaces live. Defaults in [brackets].",
    });
  } else {
    // Non-interactive: take the default for each, and SAY so — an unattended
    // run that silently picks paths is impossible to audit after the fact.
    for (const spec of gc._CONFIG_PROMPTS) {
      resolvedPaths[spec.key] = pathDefault(spec);
      info(`  ${spec.key}: ${resolvedPaths[spec.key]}`);
    }
  }

  // --- 2. browser -----------------------------------------------------------
  heading("2. Browser");
  const resolvedBrowser: Record<string, string> = {};
  const browserDefault = () => ((cfg.overrides ?? {}).browser as string) || DEFAULT_BROWSER;

  if (interactive) {
    await runWizard([BROWSER_PROMPT], resolvedBrowser, browserDefault, {
      intro: "Which browser `sandbox open` launches.",
    });
  } else {
    resolvedBrowser.browser = browserDefault();
    info(`  browser: ${resolvedBrowser.browser}`);
  }
  if (BROWSERS[resolvedBrowser.browser]?.engine !== "chromium" && resolvedBrowser.browser !== "safari") {
    warn(
      `  ${BROWSERS[resolvedBrowser.browser].label} isn't wired up yet -- ` +
        "`sandbox open` will error until it's picked to chrome/chromium/brave/edge/safari.",
    );
  }

  // --- 3. ingress ---------------------------------------------------------
  heading("3. Ingress");
  const resolvedIngress: Record<string, string> = {};
  const ingressDefault = (spec: PromptSpec): string =>
    String(currentIngress[spec.key as keyof gc.IngressSettings] ?? "");

  if (interactive) {
    await runWizard(gc._INGRESS_PROMPTS, resolvedIngress, ingressDefault, {
      intro:
        "Public hostnames Caddy terminates. Each routed service is served at " +
        "<service>.<domain>; these domains also drive the TLS certificate and " +
        "your /etc/hosts entries.",
    });
  } else {
    for (const spec of gc._INGRESS_PROMPTS) {
      resolvedIngress[spec.key] = ingressDefault(spec);
      info(`  ${spec.key}: ${resolvedIngress[spec.key]}`);
    }
  }

  // --- 4. registry --------------------------------------------------------
  heading("4. Service registry");
  const servicesYaml = gc.servicesYamlPath();
  const legacyDir = path.join(getSandboxRoot(), LEGACY_CONFIG_DIR);
  const hasLegacy = fs.existsSync(path.join(legacyDir, "services.yaml"));
  let demo = false;
  let k8sContext = "orbstack";

  if (fs.existsSync(servicesYaml)) {
    info(`Using the existing registry at ${servicesYaml} (left untouched).`);
  } else if (hasLegacy) {
    info(`Found a legacy registry at ${legacyDir} — it will be migrated to ~/.sandbox.`);
  } else {
    info(`No registry yet. One will be created at ${servicesYaml}.`);
    demo = await confirm(
      "  Seed it with the demo apps (rest-hello, next-hello) instead of an empty skeleton?",
      false,
      interactive,
    );
    if (interactive) {
      k8sContext = await prompt(
        "Kube context for `sandbox intercept` (services.yaml k8s_context)",
        k8sContext,
      );
    }
  }

  // --- 5. jira (optional; prompted here so all writes happen together) -----
  heading("5. Jira credentials (optional)");
  const jira: gc.JiraSettings = { ...gc.loadJira() };
  const jiraConfigured = Boolean(jira.base_url && jira.email && jira.api_token);
  if (jiraConfigured) {
    info(`Already configured for ${jira.email}.`);
  } else {
    info(
      "A Jira API token lets the dashboard read tickets directly instead of " +
        "shelling out to the claude CLI. Entirely optional — skip to leave it out.",
    );
    if (await confirm("  Configure Jira credentials now?", false, interactive)) {
      jira.base_url = await prompt("Jira base URL", jira.base_url ?? "https://your-org.atlassian.net");
      jira.email = await prompt("Atlassian login email", jira.email ?? "");
      info(`  Create a token at ${"https://id.atlassian.com/manage-profile/security/api-tokens"}`);
      jira.api_token = await prompt("API token", jira.api_token ?? "");
    }
  }

  // --- 6. telepresence (optional) -----------------------------------------
  heading("6. Telepresence (optional)");
  info("Only `sandbox intercept` needs it — reroutes cluster traffic to a local container.");
  const installTelepresence = await confirm(
    "  Install/upgrade the OSS client via Homebrew if it's missing or stale?",
    false,
    interactive,
  );

  // --- 7. optional plugins -------------------------------------------------
  heading("7. Superpowers plugin (optional)");
  info(
    "Brainstorming/planning skills, installed alongside ponytail. Writes its " +
      "plans and specs under docs/superpowers/. Nothing in the sandbox depends " +
      "on it, so declining is a first-class answer and `--check` stays green.",
  );
  const installOptionalPlugins = await confirm(
    "  Install the superpowers plugin?",
    false,
    interactive,
  );

  // --- write ---------------------------------------------------------------
  // Rebuilt rather than merged, but every hand-added section is carried across
  // verbatim: dropping an override or a token the wizard never asked about
  // would be a silent data loss.
  const newCfg: Record<string, any> = {
    version: 1,
    paths: {
      // Self-derived — the running checkout is authoritative. Stored only so
      // env.sh can export SANDBOX_ROOT for external processes.
      sandbox_root: String(getSandboxRoot()),
      repos_root: resolvedPaths.repos_root,
      workspaces_root: resolvedPaths.workspaces_root,
    },
    ingress: {
      local_domain: resolvedIngress.local_domain,
      remote_domain: resolvedIngress.remote_domain,
      certs_dir: resolvedIngress.certs_dir,
    },
    overrides: { ...(cfg.overrides ?? {}), browser: resolvedBrowser.browser },
    ...(jira.base_url || jira.email || jira.api_token ? { jira } : {}),
  };

  const saved = gc.save(newCfg);
  const envSh = gc.writeEnvSh(newCfg);
  const zshChanged = gc.ensureZshenvSources();
  const desktopChanged = gc.patchDesktopConfig();

  heading("Writing config");
  success(`Wrote ${saved}`);
  info(`Regenerated ${envSh}`);
  info(`${gc.zshenvPath()}: ${zshChanged ? "updated" : "already sources env.sh"}`);
  if (fs.existsSync(gc.desktopConfigPath())) {
    info(
      `${path.basename(gc.desktopConfigPath())}: ` +
        `${desktopChanged ? "dropped stale env block" : "no env block to remove"}`,
    );
  }

  return {
    demo,
    k8sContext,
    installTelepresence,
    installOptionalPlugins,
    skipSudo: !interactive,
  };
}

/**
 * The hostnames the certificate must cover.
 *
 * Reads the registry that step 3 just seeded. Returns `[]` when the registry
 * is unreadable — a fresh machine that declined to seed one has no ingress to
 * certify, and failing setup over it would be wrong.
 */
function resolveHostnames(): string[] {
  try {
    return ingressHostnames();
  } catch {
    return [];
  }
}

/**
 * Print the report; return the number of REQUIRED failures.
 *
 * Three states, because two are not enough: a not-ok optional step (no
 * Telepresence, an unreachable companion repo, a stale Jira token) is a warning
 * that leaves the machine perfectly usable, and must not make setup exit 1.
 */
function report(steps: Step[]): number {
  heading("Prerequisites");
  for (const step of steps) {
    if (step.ok) {
      console.log(`${Colors.GREEN}✓${Colors.RESET} ${step.label}: ${step.detail}`);
    } else if (step.optional) {
      console.log(`${Colors.YELLOW}⚠ ${step.label}: ${step.detail}${Colors.RESET}`);
    } else {
      console.log(`${Colors.RED}✗ ${step.label}: ${step.detail}${Colors.RESET}`);
    }
  }
  return steps.filter((s) => !s.ok && !s.optional).length;
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const check = Boolean(args.check);
  const assumeYes = Boolean(args.yes);

  // --check is a pure probe: no prompts, no writes, no config wizard.
  if (check) {
    const steps = await runSetup({ checkOnly: true, hostnames: resolveHostnames() });
    // Skip the "paths.X does not exist" problems — syncPathDirs already reports
    // each one, with the fix it would apply. Reporting both reads as two faults.
    const problems = gc
      .check(gc.load())
      .filter((p) => !/^paths\.\w+ does not exist/.test(p));
    for (const p of problems) {
      steps.unshift({ label: "global config", ok: false, detail: p });
    }
    if (report(steps)) {
      warn("Prerequisites out of date — run `sandbox setup` to converge.");
      process.exit(1);
    }
    success("All required sandbox prerequisites are in order.");
    return;
  }

  const interactive = Boolean(process.stdin.isTTY) && !assumeYes;
  if (interactive) {
    info("Sandbox setup — press Ctrl-C at any prompt to abort without writing.");
  } else if (!process.stdin.isTTY && !assumeYes) {
    warn("Not a TTY — running non-interactively with defaults (same as --yes).");
  }

  const answers = await configureMachine(interactive);

  const steps = await runSetup({
    checkOnly: false,
    registry: { demo: answers.demo, k8sContext: answers.k8sContext },
    // A thunk, not a list: on a first run services.yaml does not exist yet, and
    // runSetup calls this only after its registry step has seeded it.
    hostnames: resolveHostnames,
    skipSudo: answers.skipSudo,
    installTelepresence: answers.installTelepresence,
    installOptionalPlugins: answers.installOptionalPlugins,
  });

  const failed = report(steps);
  const warned = steps.filter((s) => !s.ok && s.optional).length;

  if (failed) {
    warn(`${failed} required prerequisite(s) could not be converged (✗ above).`);
    process.exit(1);
  }

  if (warned) {
    success(
      `Machine is set up. ${warned} optional prerequisite(s) are unconfigured ` +
        "(⚠ above) — everything works without them.",
    );
  } else {
    success("Machine is set up.");
  }
  info(
    "Plugin updates apply to new Claude Code sessions only; open a new shell " +
      "(or `source ~/.zshenv`) for the exports to take effect.",
  );
}
