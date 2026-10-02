/**
 * sandbox setup [--check] [--yes]
 *
 * The guided first-run (and re-run) of a sandbox machine. Walks through every
 * prerequisite that lives outside the checkout, writing the machine-global
 * config in `~/.sandbox` and converging the rest:
 *
 * The wizard asks everything up front, in eight sections:
 *
 *   1. paths        — repos root and workspaces root (`paths:`), plus the
 *                     GitHub locations `overrides.workspace_repo` and
 *                     `overrides.github_org`
 *   2. browser      — which browser `sandbox open` launches (`overrides.browser`)
 *   3. ingress      — base domains + cert directory (`ingress:`)
 *   4. registry     — which repo fragments will generate services.yaml; demo clone; k8s context
 *   5. jira         — OPTIONAL REST credentials for the dashboard fast path
 *   6. telepresence — OPTIONAL OSS client, via Homebrew
 *   7. superpowers  — OPTIONAL plugin, installed alongside ponytail
 *   8. editor       — OPTIONAL `yaml.schemas` entries in VS Code's user settings
 *
 * then writes the config (including `sandbox` tab completion in ~/.zshrc) and
 * converges the machine (sandbox-core/machine_setup):
 * seeding the `~/.sandbox` registry files (or migrating them up from a legacy
 * `infra/config/` checkout), the sandbox-tools and ponytail plugins, the
 * companion sandbox-workspace checkout, the TLS certificate covering every
 * routed hostname, and the four optional prerequisites above.
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
import * as path from "node:path";

import { BROWSER_PROMPT, BROWSERS, DEFAULT_BROWSER } from "sandbox-core/browser";
import { Colors, getSandboxRoot, info, success, warn } from "../lib/config.js";
import { ingressHostnames } from "sandbox-core/feature_routing";
import * as gc from "sandbox-core/global_config";
import type { PromptSpec } from "sandbox-core/global_config";
import {
  editorSchemaState,
  githubOwners,
  runSetup,
  vscodeSettingsPath,
  WORKSPACE_ROOT_REPO,
  type Step,
} from "sandbox-core/machine_setup";
import { confirm, prompt, runWizard } from "../lib/wizard.js";
import { discoverFragments, FRAGMENT_REL, inheritedK8sContext } from "sandbox-core/registry_sync";
import { expandUser } from "sandbox-core/config";

function heading(text: string): void {
  console.log(`\n${Colors.BOLD}${text}${Colors.RESET}`);
}

/** What the wizard collected, handed to `runSetup` as options. */
interface Answers {
  workspaceRepo: string;
  demo: boolean;
  k8sContext: string;
  installTelepresence: boolean;
  installOptionalPlugins: boolean;
  mapEditorSchemas: boolean;
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
  const currentIngress = gc.loadIngress(cfg);

  // --- 1. paths -----------------------------------------------------------
  heading("1. Paths & the workspace repo");
  // `resolvedPaths` is read back as it fills, so the workspaces root defaults
  // under whatever repos root was just answered.
  const resolvedPaths: Record<string, string> = {};
  const pathDefault = (spec: PromptSpec): string =>
    gc.pathDefault(spec.key, cfg, resolvedPaths);

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

  // Who on GitHub this machine works against: the repo whose worktrees become
  // each workspace root (defaulting to the running user's own — a team shares
  // workspace configs by pointing every machine at the same
  // <org>/sandbox-workspace), and the org owning the service repos.
  //
  // One gh round-trip, reused for both the defaults and the offered choices.
  const owners = githubOwners();
  if (!owners.length) {
    warn(
      "  `gh` could not name your GitHub account, so these are not prefilled — " +
        "run `gh auth login` and re-run to pick from your orgs, or type them by hand.",
    );
  }
  const withChoices = (spec: PromptSpec, values: string[]): PromptSpec =>
    values.length ? { ...spec, choicesFn: () => values } : spec;

  const resolvedGh: Record<string, string> = {};
  const ghPrompts = [
    withChoices(gc._WORKSPACE_REPO_PROMPT, owners.map((o) => `${o}/${WORKSPACE_ROOT_REPO}`)),
    withChoices(gc._GITHUB_ORG_PROMPT, owners),
  ];
  const ghDefault = (spec: PromptSpec): string => {
    if (spec.key === "workspace_repo") {
      // owners[0] is the personal account — the safe default; sharing with a
      // team is the deliberate choice of picking an org from the list.
      return gc.loadWorkspaceRepo(cfg) || (owners[0] ? `${owners[0]}/${WORKSPACE_ROOT_REPO}` : "");
    }
    // Read after the repo answer above (runWizard prompts in order), so
    // answering `acme/sandbox-workspace` pre-fills the org as `acme`.
    return (
      ((cfg.overrides ?? {}).github_org as string) ||
      (resolvedGh.workspace_repo ?? "").split("/")[0] ||
      ""
    );
  };

  if (interactive) {
    await runWizard(ghPrompts, resolvedGh, ghDefault, {
      intro:
        "GitHub locations. The workspace repo hosts the per-workspace configs " +
        "at the root of every feature workspace — enter a shared " +
        "<org>/sandbox-workspace to share them with your team, or keep your own.",
    });
  } else {
    for (const spec of ghPrompts) {
      resolvedGh[spec.key] = ghDefault(spec);
      info(`  ${spec.key}: ${resolvedGh[spec.key] || "(unset — `gh` named no user)"}`);
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
  const reposRoot = expandUser(resolvedPaths.repos_root);
  let demo = false;
  // An existing hand-written registry's context is the default (and the
  // non-interactive value): a `--yes` upgrade must not silently retarget
  // `sandbox intercept` at the default cluster.
  let k8sContext = inheritedK8sContext(servicesYaml) ?? "orbstack";

  let fragments: string[] = [];
  try {
    fragments = discoverFragments(reposRoot).map((f) => f.repo);
  } catch {
    // A broken fragment is reported by the registry step itself.
  }
  if (fragments.length) {
    info(`${servicesYaml} will be generated from ${fragments.length} repo fragment(s): ${fragments.join(", ")}.`);
  } else {
    info(`No <repo>/${FRAGMENT_REL} found under ${reposRoot}.`);
    info("Clone your team's repos there and re-run `sandbox setup`, or try the demo apps.");
  }
  if (!fragments.includes("demo-services")) {
    demo = await confirm("  Clone the demo apps (backend, frontend) so there is something to run?", false, interactive);
  }
  if (!fs.existsSync(gc.servicesLocalYamlPath()) && interactive) {
    k8sContext = await prompt(
      "Kube context for `sandbox intercept` (services.local.yaml k8s_context)",
      k8sContext,
    );
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
      jira.api_token = await prompt("API token", jira.api_token ?? "", { secret: true });
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

  // --- 8. editor schemas (optional) ----------------------------------------
  heading("8. VS Code YAML validation (optional)");
  const editor = editorSchemaState();
  let mapEditorSchemas = false;
  if (!editor.present) {
    info("VS Code not found — skipping.");
  } else if (editor.error) {
    warn(`${vscodeSettingsPath()} does not parse (${editor.error}) — skipping.`);
  } else if (!Object.keys(editor.set).length && !editor.drop.length) {
    info("Already mapped.");
  } else {
    info(
      "Validates <repo>/.sandbox/services.yaml and .sandbox/workspace.yml against the " +
        "sandbox's JSON Schemas (needs the redhat.vscode-yaml extension). Adds " +
        `\`yaml.schemas\` entries to ${vscodeSettingsPath()}; comments and other settings are kept.`,
    );
    mapEditorSchemas = await confirm("  Add the schema mappings to your VS Code user settings?", false, interactive);
  }

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
    overrides: {
      ...(cfg.overrides ?? {}),
      browser: resolvedBrowser.browser,
      // Omitted rather than written empty when unresolvable, so a later run
      // (or `gh auth login`) can still supply them.
      ...(resolvedGh.workspace_repo ? { workspace_repo: resolvedGh.workspace_repo } : {}),
      ...(resolvedGh.github_org ? { github_org: resolvedGh.github_org } : {}),
    },
    ...(jira.base_url || jira.email || jira.api_token ? { jira } : {}),
  };

  const saved = gc.save(newCfg);
  const envSh = gc.writeEnvSh(newCfg);
  const zshChanged = gc.ensureZshenvSources();
  const completionChanged = gc.ensureZshrcCompletion();
  const desktopChanged = gc.patchDesktopConfig();

  heading("Writing config");
  success(`Wrote ${saved}`);
  info(`Regenerated ${envSh}`);
  info(`${gc.zshenvPath()}: ${zshChanged ? "updated" : "already sources env.sh"}`);
  info(
    `${gc.zshrcPath()}: ` +
      `${completionChanged ? "installed tab completion" : "tab completion already installed"}`,
  );
  if (fs.existsSync(gc.desktopConfigPath())) {
    info(
      `${path.basename(gc.desktopConfigPath())}: ` +
        `${desktopChanged ? "dropped stale env block" : "no env block to remove"}`,
    );
  }

  return {
    workspaceRepo: resolvedGh.workspace_repo,
    demo,
    k8sContext,
    installTelepresence,
    installOptionalPlugins,
    mapEditorSchemas,
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
    demo: answers.demo,
    registry: { k8sContext: answers.k8sContext },
    workspaceRepo: answers.workspaceRepo,
    // A thunk, not a list: on a first run services.yaml does not exist yet, and
    // runSetup calls this only after its registry step has generated it.
    hostnames: resolveHostnames,
    skipSudo: answers.skipSudo,
    installTelepresence: answers.installTelepresence,
    installOptionalPlugins: answers.installOptionalPlugins,
    mapEditorSchemas: answers.mapEditorSchemas,
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
