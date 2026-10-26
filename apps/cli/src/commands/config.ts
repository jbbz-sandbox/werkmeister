/**
 * sandbox config [--repos-root PATH] [--workspaces-root PATH] [--show] [--check]
 *
 * Set up and maintain the machine-global sandbox configuration
 * (``~/.werkmeister/config.yaml`` — the single source of truth). On write it also
 * regenerates ``~/.werkmeister/env.sh``, installs a managed source-block in
 * ``~/.zshenv``, and strips the now-redundant ``env`` block from the sandbox MCP
 * server in ``claude_desktop_config.json`` (the ``sandbox`` wrapper self-loads
 * env.sh).
 *
 *   sandbox config                       # interactive wizard (create or edit)
 *   sandbox config --repos-root … …      # non-interactive set
 *   sandbox config --show                # print resolved config + origins
 *   sandbox config --check               # validate; nonzero exit on drift
 *
 * Values come only from the YAML at runtime; ``SANDBOX_*`` env vars are a derived
 * export for backward compatibility. On first run the wizard seeds its defaults
 * from any currently-exported ``SANDBOX_*`` so an existing machine migrates by
 * pressing Enter through.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PromptSpec } from "werkmeister-core/global_config";
import * as gc from "werkmeister-core/global_config";
import { Colors, getSandboxRoot, info, success, warn } from "../lib/config.js";
import { runWizard } from "../lib/wizard.js";

function show(cfg: ReturnType<typeof gc.load>): void {
  const paths = cfg.paths || {};
  console.log(`${Colors.BOLD}config file:${Colors.RESET} ${gc.configPath()}`);
  console.log(`${Colors.BOLD}env.sh:${Colors.RESET}      ${gc.envShPath()}`);
  console.log(
    `${Colors.BOLD}sandbox_root:${Colors.RESET}    ${getSandboxRoot()}  ${Colors.DIM}(self-derived)${Colors.RESET}`,
  );
  for (const key of ["repos_root", "workspaces_root"]) {
    const value = paths[key];
    const origin = value ? "YAML" : "default";
    // The built-in, not the wizard's default: env is a migration seed for the
    // prompts, never read at runtime, so showing it here would name a value no
    // command would actually use.
    console.log(
      `${Colors.BOLD}${key}:${Colors.RESET}      ${value || gc.builtinPathDefault(key)}  ${Colors.DIM}(${origin})${Colors.RESET}`,
    );
  }
  // Ingress is owned by `sandbox setup`, but shown here because `--show` is
  // meant to be the one place you can see the whole resolved config.
  const ingress = gc.loadIngress(cfg);
  console.log(`${Colors.BOLD}ingress:${Colors.RESET}`);
  for (const [k, v] of Object.entries(ingress)) {
    const origin = cfg.ingress?.[k] ? "YAML" : "default";
    console.log(`  ${k}: ${v}  ${Colors.DIM}(${origin})${Colors.RESET}`);
  }

  const overrides = Object.fromEntries(Object.entries(cfg.overrides || {}).filter(([, v]) => v));
  if (Object.keys(overrides).length) {
    console.log(`${Colors.BOLD}overrides:${Colors.RESET}`);
    for (const [k, v] of Object.entries(overrides)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const cfg = gc.load();

  if (args.check) {
    const problems = gc.check(cfg);
    if (problems.length) {
      for (const p of problems) {
        console.log(`${Colors.RED}✗ ${p}${Colors.RESET}`);
      }
      warn("Global config out of date — run `sandbox config` to converge.");
      process.exit(1);
    }
    success("Global sandbox config is in order.");
    return;
  }

  if (args.show) {
    show(cfg);
    return;
  }

  // Collect values: CLI flags first, then wizard/defaults for the rest.
  const resolved: Record<string, string> = {};
  if (args.repos_root) {
    resolved.repos_root = args.repos_root as string;
  }
  if (args.workspaces_root) {
    resolved.workspaces_root = args.workspaces_root as string;
  }

  // `resolved` is read back as it fills, so a later prompt's default follows
  // the answers already given.
  const defaultFor = (spec: PromptSpec): string => gc.pathDefault(spec.key, cfg, resolved);

  const missing = gc._CONFIG_PROMPTS.filter((s) => !(s.key in resolved));
  if (missing.length) {
    if (process.stdin.isTTY) {
      await runWizard(gc._CONFIG_PROMPTS, resolved, defaultFor, {
        intro: "Global sandbox config — press Ctrl-C to abort. Defaults in [brackets].",
      });
    } else {
      // Non-interactive with gaps: fall back to YAML/env/default silently.
      for (const spec of missing) {
        if (!(spec.key in resolved)) {
          resolved[spec.key] = defaultFor(spec);
        }
      }
    }
  }

  const newCfg = {
    version: 1,
    paths: {
      // sandbox_root is self-derived (the running checkout is authoritative);
      // stored only so env.sh can export SANDBOX_ROOT for external processes.
      sandbox_root: String(getSandboxRoot()),
      repos_root: resolved.repos_root,
      workspaces_root: resolved.workspaces_root,
    },
    // Preserve any hand-added overrides verbatim.
    overrides: cfg.overrides || {},
    // Same for the sections this command never prompts for: the ingress domains
    // (owned by `sandbox setup`) and the hand-pasted Jira credentials.
    // Rebuilding the YAML without them would silently drop a working ingress
    // config or a live token.
    ...(cfg.ingress ? { ingress: cfg.ingress } : {}),
    ...(cfg.jira ? { jira: cfg.jira } : {}),
    ...(cfg.projects ? { projects: cfg.projects } : {}),
  };

  const saved = gc.save(newCfg);
  const envSh = gc.writeEnvSh(newCfg);
  const zshChanged = gc.ensureZshenvSources();
  const desktopChanged = gc.patchDesktopConfig();

  success(`Wrote ${saved}`);
  info(`Regenerated ${envSh}`);
  info(`${gc.zshenvPath()}: ${zshChanged ? "updated" : "already sources env.sh"}`);
  const desktopPath = gc.desktopConfigPath();
  if (fs.existsSync(desktopPath)) {
    info(
      `${path.basename(desktopPath)}: ` +
        `${desktopChanged ? "dropped stale env block" : "no env block to remove"}`,
    );
  }
  info("Open a new shell (or `source ~/.zshenv`) for the exports to take effect.");
}
