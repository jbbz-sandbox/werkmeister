#!/usr/bin/env node
/**
 * Werkmeister CLI
 *
 * A multi-feature concurrent development orchestrator that lets many
 * Claude Code agents develop features at once (12 slots by default). Each feature runs
 * only the services it modifies locally, with everything else
 * port-forwarded from k8s.
 *
 * Usage: werkmeister <noun> <verb> [args] (SW-186). `werkmeister --help` lists the
 * nouns, `werkmeister <noun> --help` their verbs; both come from SPECS below.
 *
 * Feature name can be omitted if FEATURE is set in a .env file in the cwd.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Argument, Command, Option } from "commander";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import { envVar } from "werkmeister-core/config";
import { SandboxError, WORKSPACE_ERROR_CODE } from "werkmeister-core/errors";
import { error, ttyReporter, withReporter } from "werkmeister-core/reporter";
// `./strategies/types` isn't its own package export, and `./strategies`
// pulls in the registry (fs/proc/reporter/jit/icm) — accepted here since
// werkmeister-core is already this CLI's core dependency and every command
// module loads far more of it on demand.
import { STRATEGY_IDS } from "werkmeister-core/strategies";
import budgetHelp from "./commands/budget.help.md";
import cacheHelp from "./commands/cache.help.md";
import cleanHelp from "./commands/clean.help.md";
import closeOutHelp from "./commands/close-out.help.md";
import codeHelp from "./commands/code.help.md";
import configHelp from "./commands/config.help.md";
import connectHelp from "./commands/connect.help.md";
import daemonHelp from "./commands/daemon.help.md";
import dashboardHelp from "./commands/dashboard.help.md";
import detectHelp from "./commands/detect.help.md";
import downHelp from "./commands/down.help.md";
import hooksHelp from "./commands/hooks.help.md";
import initWorkspaceHelp from "./commands/init-workspace.help.md";
import interceptHelp from "./commands/intercept.help.md";
import issueHelp from "./commands/issue.help.md";
import listWorkspacesHelp from "./commands/list-workspaces.help.md";
import logsHelp from "./commands/logs.help.md";
import mcpHelp from "./commands/mcp.help.md";
import migrateHelp from "./commands/migrate.help.md";
import notesHelp from "./commands/notes.help.md";
import openHelp from "./commands/open.help.md";
import optimizeHelp from "./commands/optimize.help.md";
import pauseHelp from "./commands/pause.help.md";
import prHelp from "./commands/pr.help.md";
import proxyReloadHelp from "./commands/proxy-reload.help.md";
import registryHelp from "./commands/registry.help.md";
import removeHelp from "./commands/remove.help.md";
import removeWorkspaceHelp from "./commands/remove-workspace.help.md";
import restartHelp from "./commands/restart.help.md";
import resumeHelp from "./commands/resume.help.md";
import servicesHelp from "./commands/services.help.md";
import setupHelp from "./commands/setup.help.md";
import skillsHelp from "./commands/skills.help.md";
import standardsHelp from "./commands/standards.help.md";
import startArgsHelp from "./commands/start-args.help.md";
import startingPromptHelp from "./commands/starting-prompt.help.md";
import statsHelp from "./commands/stats.help.md";
import statusHelp from "./commands/status.help.md";
import stopHelp from "./commands/stop.help.md";
import testHelp from "./commands/test.help.md";
import upHelp from "./commands/up.help.md";
import waitLoadHelp from "./commands/wait-load.help.md";
import workspaceHelp from "./commands/workspace.help.md";
import { BUILD_STAMP, staleBuildWarning } from "./lib/build_freshness.js";
import { installDefaultInterrupt } from "./lib/interrupt.js";

// Repo root (contains infra/, docs/, dist/). Exported as WERKMEISTER_ROOT for the
// config loaders.
const _REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!envVar("ROOT")) {
  process.env.WERKMEISTER_ROOT = _REPO_ROOT;
}

// ANSI helpers (duplicated here to stay import-light before dispatch)
const _RED = "\x1b[31m";
const _BOLD = "\x1b[1m";
const _RESET = "\x1b[0m";

const BANNER = `${_BOLD}Werkmeister CLI${_RESET}
Multi-feature concurrent development orchestrator
`;

/**
 * The parsed-argument bag handed to every command module's run().
 * Keys use snake_case names so command modules read
 * `args.issue_id` etc. verbatim.
 */
export type Namespace = Record<string, unknown>;

// Root --help sections, in this order (commander orders sections by first registration).
const GROUPS = [
  "Features:",
  "Workspaces:",
  "PRs and issues:",
  "Services and infra:",
  "Agent context:",
  "Machine:",
  "Internal:",
] as const;

// SW-186: the pre-noun-group spellings warn until this release, then go (three minor releases).
const REMOVE_IN = "0.58.0";

// The `<noun>` level of `werkmeister <noun> <verb>` (SW-186, proposal 1.3).
const NOUNS: Record<string, { description: string; help?: string; alias?: string }> = {
  feature: { description: "Run a feature's containers: up, down, stop, logs, test and the rest" },
  workspace: {
    description: "Create, reconcile, list, open and close workspaces",
    alias: "ws",
  },
  pr: {
    description:
      "Open and track this workspace's PRs from its PR files (docs/workspace-lifecycle.md)",
    help: prHelp,
  },
  issue: {
    description:
      "Read, update or file an issue in this machine's issue tracker (see `werkmeister machine setup`)",
    help: issueHelp,
  },
  infra: { description: "Shared infrastructure: Caddy, k8s port-forwards and Telepresence" },
  machine: { description: "Machine-wide setup, config, migration and housekeeping" },
  budget: {
    description: "The scheduler's budget, the slots held and the features Waiting for room",
    help: budgetHelp,
  },
  daemon: { description: "The host daemon (the MCP server on port 3002)", help: daemonHelp },
  internal: { description: "Hook, tool and sibling-app entry points; not typed by people" },
};

type CommandSpec = {
  /** `<noun> <verb>`, or one word for a command that takes its own `<action>` (`skills check`). */
  name: string;
  group: (typeof GROUPS)[number];
  /** The command's help.md, bundled as text (esbuild.mjs) and printed after its options. */
  help: string;
  /**
   * Import the command module. A thunk around a *literal* specifier, not a
   * `./commands/${name}.js` built from a string field: only the literal form is
   * resolved by tsc and by the esbuild bundle the published package ships
   * (note 038 — a computed specifier compiles and bundles clean while resolving
   * nowhere, which is how the same class of bug survived three PRs).
   */
  load: (args: Namespace) => Promise<{ run: (args: Namespace) => void | Promise<void> }>;
  configure: (cmd: Command) => void;
  // Map commander (positionals, opts) → the args namespace.
  namespace: (args: unknown[], opts: Record<string, unknown>) => Namespace;
  /** The pre-SW-186 top-level spelling: hidden, warns until REMOVE_IN, then runs this spec. */
  old?: string;
  /**
   * A pre-SW-186 command kept whole because its flags now split across several
   * commands (`stop --if-idle`): hidden, and warns naming the spelling this returns.
   */
  deprecated?: (args: Namespace) => string;
  /** Runs when its noun is given no verb: `workspace <feature>` predates `workspace new`. */
  isDefault?: boolean;
};

const deprecation = (old: string, now: string) =>
  `werkmeister: '${old}' is deprecated and will be removed in ${REMOVE_IN}; use 'werkmeister ${now}'. ` +
  "Run 'werkmeister machine migrate' to update hooks and permission rules.";

const SPECS: CommandSpec[] = [
  {
    name: "feature up",
    old: "up",
    group: "Features:",
    help: upHelp,
    load: () => import("./commands/up.js"),
    configure: (cmd) => {
      cmd
        .description("Detect services, allocate slot, generate config, start containers")
        .argument(
          "[feature]",
          "Feature name (arbitrary label for slot/proxy routing). " +
            "If omitted, read from FEATURE in a .env file in the current directory tree.",
        )
        .option(
          "-w, --workspace <path>",
          "Path to directory containing repo checkouts. Default: ~/workspace (override with WORKSPACE env var).",
        )
        .option(
          "--dev",
          "Run the file watchers in cli/library/extension containers, which otherwise idle.",
        )
        .option(
          "--service <name>",
          "Start only this service and wait for it, the way the PR gate does — including one " +
            "behind the on-demand profile (SW-132). `feature stop` stops it.",
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      workspace: o.workspace ?? null,
      dev: o.dev ?? false,
      ...(o.service ? { service: o.service } : {}),
    }),
  },
  {
    name: "feature down",
    old: "down",
    group: "Features:",
    help: downHelp,
    load: () => import("./commands/down.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Stop containers, release slot, update proxy (`infra <verb>` for shared infra)",
        )
        .argument(
          "[feature]",
          "Feature name or 'infra'. If omitted, read from FEATURE in a .env file.",
        )
        .option("-v, --volumes", "Also remove Docker volumes (node_modules, caches)")
        .option(
          "--all-features",
          "Stop and clean up all active features (ignores <feature> argument)",
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      volumes: Boolean(o.volumes),
      all_features: Boolean(o.allFeatures),
    }),
  },
  {
    name: "infra intercept",
    old: "intercept",
    group: "Services and infra:",
    help: interceptHelp,
    load: () => import("./commands/intercept.js"),
    configure: (cmd) => {
      cmd
        .description("Route header-scoped k8s dev traffic to a local service (Telepresence OSS).")
        .argument("[feature]", "Feature name (defaults to FEATURE from a .env file in CWD).")
        .option(
          "-s, --service <name>",
          "Local service to intercept (must be in the workspace's SERVICES and running via `werkmeister feature up`).",
        )
        .option(
          "--leave",
          "End the intercept for -s (or all of this feature's intercepts without -s).",
        )
        .option("--status", "Show telepresence connection and intercept status.")
        .option(
          "--docker-daemon",
          "Run the telepresence daemon in a container (connect --docker) — " +
            "avoids the host TUN device, its sudo prompt, and VPN routing conflicts. " +
            "In exchange the host loses cluster DNS: nothing on your laptop resolves " +
            "<svc>.<ns> while connected this way.",
        )
        .option(
          "--workspace <path>",
          "Explicit workspace path (default: resolve from the feature name).",
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      service: o.service ?? null,
      leave: Boolean(o.leave),
      status: Boolean(o.status),
      docker_daemon: Boolean(o.dockerDaemon),
      workspace: o.workspace ?? null,
    }),
  },
  {
    name: "feature restart",
    old: "restart",
    group: "Features:",
    help: restartHelp,
    load: () => import("./commands/restart.js"),
    configure: (cmd) => {
      cmd
        .description("Restart containers (`infra <verb>` for shared infra)")
        .argument(
          "[feature]",
          "Feature name or 'infra'. If omitted, read from FEATURE in a .env file.",
        );
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "feature pause",
    old: "pause",
    group: "Features:",
    help: pauseHelp,
    load: () => import("./commands/pause.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Freeze a workspace's running containers and hold its Claude session until resume",
        )
        .argument("[feature]", "Feature name. If omitted, read from FEATURE in a .env file.");
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "feature resume",
    old: "resume",
    group: "Features:",
    help: resumeHelp,
    load: () => import("./commands/resume.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Thaw exactly the containers pause froze, release the session, and tell it to continue",
        )
        .argument("[feature]", "Feature name. If omitted, read from FEATURE in a .env file.");
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "stop",
    deprecated: (a) =>
      a.if_idle
        ? "internal session-end"
        : a.idle
          ? "internal reap <minutes>"
          : a.feature === "infra"
            ? "infra stop"
            : "feature stop",
    group: "Features:",
    help: stopHelp,
    load: () => import("./commands/stop.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Stop containers without removing them or releasing the slot (`infra <verb>` for shared infra)",
        )
        .argument(
          "[feature]",
          "Feature name or 'infra'. If omitted, read from FEATURE in a .env file.",
        )
        .option(
          "--if-idle",
          "SessionEnd hook mode: stop the workspace's own feature unless another Claude " +
            "session is open there; silent, always exits 0, never stops infra",
        )
        .option(
          "--idle <minutes>",
          "Stop every workspace's feature containers nothing has used for <minutes> (a busy or " +
            "recently active session, a gate exec or a fresh start all count as use); with " +
            "[feature], only that one",
        )
        // Internal: the child --if-idle spawns, which hands the stop to the host daemon (SW-184).
        .addOption(new Option("--via-daemon").hideHelp());
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      if_idle: Boolean(o.ifIdle),
      idle: o.idle ?? null,
      via_daemon: Boolean(o.viaDaemon),
    }),
  },
  {
    name: "status",
    deprecated: (a) => (a.k8s ? "infra status" : "feature status"),
    group: "Features:",
    help: statusHelp,
    load: () => import("./commands/status.js"),
    configure: (cmd) => {
      cmd
        .description("Show all features, services, resource usage")
        .option("-v, --verbose", "Show individual container details")
        .option(
          "--k8s",
          "Show k8s port-forward health only (replaces standalone k8s-status command)",
        )
        .option(
          "--intercepts",
          "Show Telepresence intercept state only (per feature service; cheap — skips docker and k8s probes).",
        )
        .option("--json", "Output structured JSON (useful for agent-driven diagnosis)");
    },
    namespace: (_a, o) => ({
      verbose: Boolean(o.verbose),
      k8s: Boolean(o.k8s),
      intercepts: Boolean(o.intercepts),
      json: Boolean(o.json),
    }),
  },
  {
    name: "machine detect",
    old: "detect",
    group: "Machine:",
    help: detectHelp,
    load: () => import("./commands/detect.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Generate <repo>/.werkmeister/services.yaml from the repo's package manifests, " +
            "Dockerfiles, compose, Helm and k8s files (re-runs only add what is missing)",
        )
        .argument(
          "[repo]",
          "Repo directory (default: the git repo containing the current directory)",
        )
        .option("--dry-run", "Show the report and the proposed YAML; write nothing")
        .option("-y, --yes", "Write without asking")
        .option("--assist", "Ask Claude to resolve the fields the scan had to guess")
        .option("--no-assist", "Never ask Claude");
    },
    namespace: ([repo], o) => ({
      repo: repo ?? null,
      dryRun: Boolean(o.dryRun),
      yes: Boolean(o.yes),
      assist: o.assist,
    }),
  },
  {
    name: "feature services",
    old: "services",
    group: "Features:",
    help: servicesHelp,
    load: () => import("./commands/services.js"),
    configure: (cmd) => {
      cmd
        .description("List services and their endpoints for a feature")
        .argument("<feature>", "Feature name");
    },
    namespace: ([feature]) => ({ feature }),
  },
  {
    name: "feature logs",
    old: "logs",
    group: "Features:",
    help: logsHelp,
    load: () => import("./commands/logs.js"),
    configure: (cmd) => {
      cmd
        .description("Tail a feature's container logs")
        .argument("<feature>", "Feature name")
        .argument("[service]", "Specific service to tail (optional)");
    },
    namespace: ([feature, service]) => ({ feature, service: service ?? null }),
  },
  {
    name: "feature drop",
    old: "remove",
    group: "Features:",
    help: removeHelp,
    load: () => import("./commands/remove.js"),
    configure: (cmd) => {
      cmd
        .description("Stop a local service, fall back to k8s")
        .argument("<feature>", "Feature name")
        .argument("<service>", "Service name to remove");
    },
    namespace: ([feature, service]) => ({ feature, service }),
  },
  {
    name: "feature test",
    old: "test",
    group: "Features:",
    help: testHelp,
    load: () => import("./commands/test.js"),
    configure: (cmd) => {
      cmd
        .description("Run Playwright tests against a feature's stack")
        .argument("<feature>", "Feature name")
        .argument("[extra...]", "Additional arguments to pass to Playwright")
        .option(
          "--scaffold",
          "Don't run: write playwright.config.ts + <feature>.spec.ts into the workspace " +
            "(if missing) and install the pinned @playwright/test",
        )
        .option("-w, --workspace <path>", "--scaffold: workspace directory (default: from cwd)")
        .option(
          "--base-url <url>",
          "--scaffold: ingress URL to target (default: the first feature_router service)",
        );
    },
    namespace: ([feature, extra], o) => ({
      feature,
      extra: extra ?? [],
      scaffold: o.scaffold ?? false,
      workspace: o.workspace ?? null,
      base_url: o.baseUrl ?? null,
    }),
  },
  {
    name: "workspace prompt",
    old: "starting-prompt",
    group: "Workspaces:",
    help: startingPromptHelp,
    load: (a) =>
      a.args ? import("./commands/start_args.js") : import("./commands/starting_prompt.js"),
    configure: (cmd) => {
      cmd
        .description("Print the enclosing workspace's starting_prompt from workspace.yml")
        .option("--start <dir>", "Directory to search up from (default: cwd)")
        .option(
          "--args",
          "Print the start_session arguments (title, model, prompt, background) as JSON instead",
        );
    },
    namespace: (_args, o) => ({ start: o.start ?? null, ...(o.args ? { args: true } : {}) }),
  },
  {
    name: "start-args",
    deprecated: () => "workspace prompt --args",
    group: "Internal:",
    help: startArgsHelp,
    load: () => import("./commands/start_args.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Print the start_session arguments (title, model, prompt, background) for the enclosing workspace, as JSON",
        )
        .option("--start <dir>", "Directory to search up from (default: cwd)");
    },
    namespace: (_args, o) => ({ start: o.start ?? null }),
  },
  {
    name: "internal wait-load",
    old: "wait-load",
    group: "Internal:",
    help: waitLoadHelp,
    load: () => import("./commands/wait_load.js"),
    configure: (cmd) => {
      cmd.description(
        "Wait, up to 10 min, while host load is above budget.host_load; with-temp-home runs it first",
      );
    },
    namespace: () => ({}),
  },
  {
    name: "feature open",
    old: "open",
    group: "Features:",
    help: openHelp,
    load: () => import("./commands/open.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Open a feature-tagged Chrome window with the X-Feature cookie set (no Playwright)",
        )
        .argument(
          "[feature]",
          "Feature name -> sets X-Feature=<feature>. If omitted, read from FEATURE in a .env file.",
        )
        .option(
          "--url <url>",
          "Full start URL (overrides --path). Default: the first routed host's homepage.",
        )
        .option(
          "--path <path>",
          "Path appended to the first routed host " +
            "(default: test_path from .werkmeister/workspace.yml, else TEST_PATH from .env, else '/').",
        )
        .option("--size <W,H>", "Window size WIDTH,HEIGHT (default: 1440,900).", "1440,900")
        .option("--position <X,Y>", "Window position X,Y (default: staggered by feature name).");
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      url: o.url ?? null,
      path: o.path ?? null,
      size: o.size,
      position: o.position ?? null,
    }),
  },
  {
    name: "infra connect",
    old: "connect",
    group: "Services and infra:",
    help: connectHelp,
    load: () => import("./commands/connect.js"),
    configure: (cmd) => {
      cmd
        .description("Start all shared infrastructure (local + k8s port-forwards)")
        .option(
          "--k8s",
          "Start/restart k8s port-forwards container only (replaces standalone k8s-connect command)",
        );
    },
    namespace: (_a, o) => ({ k8s: Boolean(o.k8s) }),
  },
  {
    name: "infra proxy-reload",
    old: "proxy-reload",
    group: "Services and infra:",
    help: proxyReloadHelp,
    load: () => import("./commands/proxy_reload.js"),
    configure: (cmd) => {
      cmd.description("Regenerate Caddyfile and reload Caddy");
    },
    namespace: () => ({}),
  },
  {
    name: "machine clean",
    old: "clean",
    group: "Machine:",
    help: cleanHelp,
    load: () => import("./commands/clean.js"),
    configure: (cmd) => {
      cmd
        .description("Remove orphaned volumes and generated files from stopped features")
        .option(
          "--all",
          "Also clean volumes for currently active features (implies werkmeister down for each)",
        )
        .option("--dry-run", "Show what would be cleaned without actually removing anything");
    },
    namespace: (_a, o) => ({ all: Boolean(o.all), dry_run: Boolean(o.dryRun) }),
  },
  {
    name: "machine stats",
    old: "stats",
    group: "Machine:",
    help: statsHelp,
    load: () => import("./commands/stats.js"),
    configure: (cmd) => {
      cmd
        .description("Show Docker container resource usage (CPU, memory)")
        .option(
          "--collect <MINUTES>",
          "Collect stats over N minutes (default: snapshot only)",
          (v) => Number.parseInt(v, 10),
          0,
        )
        .option(
          "-i, --interval <SECS>",
          "Sampling interval in seconds (default: 10)",
          (v) => Number.parseInt(v, 10),
          10,
        )
        .option("--save", "Save results to stats/ directory");
    },
    namespace: (_a, o) => ({ collect: o.collect, interval: o.interval, save: Boolean(o.save) }),
  },
  {
    name: "machine optimize",
    old: "optimize",
    group: "Machine:",
    help: optimizeHelp,
    load: () => import("./commands/optimize.js"),
    configure: (cmd) => {
      cmd
        .description("Analyze resource usage vs configured limits, recommend changes")
        .option(
          "--collect <MINUTES>",
          "Collect stats over N minutes before analyzing (default: quick snapshot)",
          (v) => Number.parseInt(v, 10),
          0,
        )
        .option(
          "-i, --interval <SECS>",
          "Sampling interval in seconds (default: 10)",
          (v) => Number.parseInt(v, 10),
          10,
        );
    },
    namespace: (_a, o) => ({ collect: o.collect, interval: o.interval }),
  },
  {
    name: "skills",
    group: "Agent context:",
    help: skillsHelp,
    load: () => import("./commands/skills.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Workspace w9r-* skill projection: verify freshness against the " +
            "werkmeister repo (check) or rewrite it (sync)",
        )
        .addArgument(
          new Argument(
            "<action>",
            "check: exit 1 if the workspace's .claude/skills/w9r-* lag the repo; sync: refresh them",
          ).choices(["check", "sync"]),
        );
    },
    namespace: ([action]) => ({ action }),
  },
  {
    name: "standards",
    group: "Agent context:",
    help: standardsHelp,
    load: () => import("./commands/standards.js"),
    configure: (cmd) => {
      cmd
        .description("Validate the configured standards tree (structural regression gate)")
        .addArgument(
          new Argument(
            "<action>",
            "check: exit 1 if any standard module is structurally malformed",
          ).choices(["check"]),
        );
    },
    namespace: ([action]) => ({ action }),
  },
  {
    name: "hooks",
    deprecated: (a) => `internal ${a.action}`,
    group: "Internal:",
    help: hooksHelp,
    load: () => import("./commands/hooks.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Claude Code hook entrypoints: the standards gate, the PR guard and the agent state",
        )
        .addArgument(
          new Argument(
            "<action>",
            "gate: deny or allow an Edit/Write per the standards gate; pr-guard: deny opening a PR except via `werkmeister pr open`; " +
              "agent-state: record working / needs-you / done for the workspace pane and dashboard",
          ).choices(["gate", "pr-guard", "agent-state"]),
        );
    },
    namespace: ([action]) => ({ action }),
  },
  {
    name: "notes",
    group: "Agent context:",
    help: notesHelp,
    load: () => import("./commands/notes.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Workspace notes (.werkmeister/notes/). `context` prints the latest " +
            "handoff + open decisions for session-start injection (hook target); " +
            "`graduate` scaffolds an open decision note into the standards tree.",
        )
        .addArgument(
          new Argument(
            "<action>",
            "context: print notes context for the enclosing workspace (silent if none); " +
              "graduate: scaffold an open decision note into the standards tree",
          ).choices(["context", "graduate"]),
        )
        .argument("[note_num]", "graduate: note number to graduate (omit to pick interactively)")
        .option(
          "--domain <domain>",
          "graduate: target <domain> in the standards tree (omit to infer from refs, or prompt)",
        )
        .addOption(
          new Option(
            "--kind <kind>",
            "graduate: content kind to scaffold (omit to prompt)",
          ).choices(["rule", "example", "anti-pattern"]),
        )
        .option("--slug <slug>", "graduate: override the derived reference-file slug");
    },
    namespace: ([action, noteNum], o) => ({
      action,
      note_num: noteNum == null ? null : Number.parseInt(noteNum as string, 10),
      domain: o.domain ?? null,
      kind: o.kind ?? null,
      slug: o.slug ?? null,
    }),
  },
  {
    name: "workspace new",
    isDefault: true,
    group: "Workspaces:",
    help: workspaceHelp,
    load: () => import("./commands/workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Create a new workspace under $WERKMEISTER_WORKSPACES_ROOT (git worktrees " +
            "on a <user>/<workspace> branch) and run init-workspace inside it.",
        )
        .argument(
          "[feature]",
          "Feature name (lower-cased). Combined with --issue-id to form the " +
            "workspace dir name, e.g. an issue + feature -> <issue-slug>-feature. " +
            "If omitted, resolved from ./.werkmeister/workspace.yml, then interactively (TTY).",
        )
        .option(
          "--issue-id <ref>",
          "Issue ID in this machine's issue tracker (see `werkmeister machine setup`). Its slug is " +
            "prefixed to the workspace dir name; passed through to init-workspace.",
        )
        .option(
          "--project <name>",
          "The project (projects: in ~/.werkmeister/config.yaml) whose tracker holds the issue. " +
            "Default: the one whose scope holds --issue-id, else the default project.",
        )
        .option(
          "-s, --services <list>",
          "Comma-separated services to run locally. Their owning repos are " +
            "added as worktrees, and the list is passed through to init-workspace.",
        )
        .option(
          "-r, --repos <list>",
          "Comma-separated repos to create worktrees for (union with the " +
            "repos derived from --services). Interactive multi-select if neither " +
            "--repos nor --services is given.",
        )
        .option(
          "--labels <list>",
          "Comma-separated free-form tags for filtering workspaces in the dashboard search; passed through to init-workspace.",
        )
        .option(
          "-t, --task <title>",
          "Task title for the workspace CLAUDE.md; passed through to init-workspace.",
        )
        .option(
          "--test-path <path>",
          "URL path for feature testing; passed through to init-workspace.",
        )
        .option(
          "--description <text>",
          "Free-form description for the CLAUDE.md header; passed through to init-workspace.",
        )
        .option(
          "--starting-prompt <text>",
          "First instruction for the agent; passed through to init-workspace.",
        )
        .addOption(
          new Option(
            "--work-type <type>",
            "Kind of work; seeds the first-phase handoff note. Passed through to init-workspace.",
          ).choices(["feature", "bugfix", "refactor", "spike", "incident"]),
        )
        .addOption(
          new Option(
            "--context-strategy <id>",
            "Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). " +
              "(env: WERKMEISTER_CONTEXT_STRATEGY; config: context_strategy).",
          ).choices([...STRATEGY_IDS]),
        )
        .option(
          "--autonomous",
          "Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a " +
            "headless session needs (env: WERKMEISTER_AUTONOMOUS; config: autonomous).",
        )
        .option(
          "--model <id>",
          "Claude model for this workspace's sessions: an alias (opus, sonnet, haiku) or a " +
            "claude-… id; blank keeps Claude Code's default (env: WERKMEISTER_MODEL; config: model).",
        )
        .option(
          "--auto-stop",
          "Stop this workspace's feature containers when a Claude session in it ends and no " +
            "other is open (a SessionEnd hook; env: WERKMEISTER_AUTO_STOP; config: auto_stop).",
        )
        .option(
          "--browser-form",
          "Collect inputs through the Werkmeister-branded browser form (the same " +
            "form the Desktop MCP App renders), pre-filled from every flag given, then create the workspace. Opens a " +
            "localhost page in the default browser and blocks until submit/cancel.",
        )
        .option(
          "--no-distill",
          "Store the issue but don't have a model rewrite it into description/starting_prompt.",
        )
        .option(
          "--open",
          "With --browser-form: launch VS Code on the new workspace after creating.",
        )
        .option(
          "--force",
          "Delete a <user>/<workspace> branch an earlier workspace of the same name left on " +
            "origin, instead of aborting (that branch's work is gone; see the abort message " +
            "for how to continue it instead).",
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      issue_id: o.issueId ?? null,
      project: o.project ?? null,
      services: o.services ?? null,
      repos: o.repos ?? null,
      labels: o.labels ?? null,
      task: o.task ?? null,
      test_path: o.testPath ?? null,
      description: o.description ?? null,
      starting_prompt: o.startingPrompt ?? null,
      work_type: o.workType ?? null,
      context_strategy: o.contextStrategy ?? null,
      autonomous: o.autonomous ?? null,
      model: o.model ?? null,
      auto_stop: o.autoStop ?? null,
      browser_form: Boolean(o.browserForm),
      open_vscode: Boolean(o.open),
      no_distill: o.distill === false,
      force: Boolean(o.force),
    }),
  },
  {
    name: "workspace list",
    old: "list-workspaces",
    group: "Workspaces:",
    help: listWorkspacesHelp,
    load: () => import("./commands/list_workspaces.js"),
    configure: (cmd) => {
      cmd.description("List the workspaces under the workspaces root with their issue and labels");
    },
    namespace: () => ({}),
  },
  {
    name: "remove-workspace",
    deprecated: () => "workspace abandon <reason>",
    group: "Workspaces:",
    help: removeWorkspaceHelp,
    load: () => import("./commands/remove_workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Deprecated: use `werkmeister workspace abandon <reason>`. Hand off (commit + push) and delete a workspace",
        )
        .argument("<name>", "Workspace directory name, as `werkmeister workspace list` reports it")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--abandon <reason>",
          "Remove despite unshipped work; records the reason in closeout.md and the PR files",
        );
    },
    namespace: ([name], o) => ({ name, yes: Boolean(o.yes), abandon: o.abandon ?? null }),
  },
  {
    name: "close-out",
    deprecated: (a) => (a.abandon ? "workspace abandon <reason>" : "workspace close"),
    group: "Workspaces:",
    help: closeOutHelp,
    load: () => import("./commands/close_out.js"),
    configure: (cmd) => {
      cmd
        .description(
          "End a workspace. After every PR shipped: close the issue, write closeout.md, remove the workspace, delete merged branches. " +
            "With --abandon: record the reason, push every branch and keep them, remove the workspace. " +
            "Refuses without postmortem.md (run the post-mortem first) unless --skip-postmortem gives a reason",
        )
        .argument("[name]", "Workspace directory name; defaults to the workspace you are in")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--abandon <reason>",
          "Close out without shipping; the reason goes in closeout.md and the PR files",
        )
        .option(
          "--skip-postmortem <reason>",
          "Close out without a post-mortem; the reason goes in closeout.md",
        );
    },
    namespace: ([name], o) => ({
      name: name ?? null,
      yes: Boolean(o.yes),
      abandon: o.abandon ?? null,
      skipPostmortem: o.skipPostmortem ?? null,
    }),
  },
  {
    name: "workspace code",
    old: "code",
    group: "Workspaces:",
    help: codeHelp,
    load: () => import("./commands/code.js"),
    configure: (cmd) => {
      cmd
        .description("Open a workspace in VS Code")
        .argument(
          "[feature]",
          "Workspace name, as `werkmeister workspace list` reports it. If omitted, read from FEATURE in a .env file.",
        );
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "machine setup",
    old: "setup",
    group: "Machine:",
    help: setupHelp,
    load: () => import("./commands/setup.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Guided machine setup: walks through paths, ingress domains and the " +
            "~/.werkmeister service registry, then converges the plugins, the " +
            "sandbox-workspace checkout, the TLS certificate and the optional " +
            "issue tracker, Telepresence and VS Code YAML-schema prerequisites",
        )
        .option(
          "--check",
          "Report prerequisite state without prompting or running any install/update commands",
        )
        .option("--yes", "Non-interactive: accept every default and skip optional installs");
    },
    namespace: (_a, o) => ({ check: Boolean(o.check), yes: Boolean(o.yes) }),
  },
  {
    name: "machine config",
    old: "config",
    group: "Machine:",
    help: configHelp,
    load: () => import("./commands/config.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Set up and maintain the machine-global werkmeister config " +
            "(~/.werkmeister/config.yaml — the single source of truth); regenerates " +
            "env.sh and wires up ~/.zshenv and the Desktop MCP config",
        )
        .option(
          "--write",
          "Write config.yaml (prompting on a TTY for unset values), regenerate env.sh, " +
            "and wire up ~/.zshenv and the Desktop MCP config. Without it (or a value " +
            "to set) the command only prints the config.",
        )
        .option(
          "--repos-root <path>",
          "Absolute path to the canonical source-repo clones (non-interactive set).",
        )
        .option(
          "--workspaces-root <path>",
          "Absolute path to the per-feature worktree workspaces (non-interactive set).",
        )
        .option("--show", "Print the resolved config and each value's origin (the default).")
        .option("--check", "Validate config + derived files; nonzero exit on drift.");
    },
    namespace: (_a, o) => ({
      write: Boolean(o.write),
      repos_root: o.reposRoot ?? null,
      workspaces_root: o.workspacesRoot ?? null,
      show: Boolean(o.show),
      check: Boolean(o.check),
    }),
  },
  {
    name: "cache",
    group: "Machine:",
    help: cacheHelp,
    load: () => import("./commands/cache.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Prune the shared build and package caches (`caches:` in the registry) by each one's age " +
            "or prune rule",
        )
        .argument("<action>", "prune — the only action")
        .argument("[name]", "One cache; every cache when omitted")
        .option("--reset", "Empty the cache(s) instead of applying the rule.")
        .option("--force", "Prune a cache even while a running container mounts it.")
        .option("--dry-run", "Report what would be deleted; change nothing.");
    },
    namespace: ([action, name], o) => ({
      action,
      name: name ?? null,
      reset: Boolean(o.reset),
      force: Boolean(o.force),
      dry_run: Boolean(o.dryRun),
    }),
  },
  {
    name: "registry",
    group: "Machine:",
    help: registryHelp,
    load: () => import("./commands/registry.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Regenerate ~/.werkmeister/services.yaml from every <repo>/.werkmeister/services.yaml " +
            "under paths.repos_root (merged under " +
            "~/.werkmeister/services.local.yaml)",
        )
        .argument("[action]", "sync — the default and only action")
        .option("--check", "Report drift without writing; nonzero exit when stale.");
    },
    namespace: ([action], o) => ({ action: action ?? "sync", check: Boolean(o.check) }),
  },
  {
    name: "machine migrate",
    old: "migrate",
    group: "Machine:",
    help: migrateHelp,
    load: () => import("./commands/migrate.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Move ~/.sandbox to ~/.werkmeister and repoint everything that names it: config.yaml, " + // name-check: ignore
            "env.sh, the ~/.zshenv block, services.yaml, the pr-watch schedule and workspace " +
            "compose files; then rewrite workspace hooks, permission rules and with-temp-home, " +
            "secrets.env and Claude Desktop's args to the noun-group spellings. Safe to re-run; " +
            "refuses while affected containers are running.",
        )
        .option("--workspaces", "Also rename each workspace's .sandbox/ to .werkmeister/.") // name-check: ignore
        .option("--check", "Report what would change without writing.");
    },
    namespace: (_args, o) => ({ check: Boolean(o.check), workspaces: Boolean(o.workspaces) }),
  },
  {
    name: "workspace init",
    old: "init-workspace",
    group: "Workspaces:",
    help: initWorkspaceHelp,
    load: () => import("./commands/init_workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Reconcile a workspace from .werkmeister/workspace.yml: create/remove " +
            "repo worktrees to match the `repos`/`services` fields, then (re)generate " +
            `CLAUDE.md / .env / ${COMPOSE_FILE}. Idempotent — edit workspace.yml and ` +
            "rerun. Inputs resolve as CLI flag > env (WERKMEISTER_*) > workspace.yml.",
        )
        .option(
          "-t, --task <title>",
          "Task description / title (env: WERKMEISTER_TASK; config: task).",
        )
        .option("--feature <name>", "Feature name for workspace slot routing (config: feature).")
        .option(
          "--services <list>",
          "Comma-separated list of local services (env: WERKMEISTER_SERVICES; config: services). " +
            "Their owning repos are added to the reconciled worktree set.",
        )
        .option(
          "-r, --repos <list>",
          "Comma-separated repos to keep as git worktrees (union with the repos " +
            "owning --services). Persisted to workspace.yml; the worktree set is reconciled " +
            "to match on every run (env: WERKMEISTER_REPOS; config: repos).",
        )
        .option(
          "--force",
          "When reconciling, delete repo worktrees dropped from workspace.yml even if " +
            "they have uncommitted changes, and delete a <user>/<workspace> branch an earlier " +
            "workspace left on origin instead of aborting (default: abort without changes).",
        )
        .option(
          "--no-build",
          "Write compose.yml and the context files but skip the image build " +
            "(`docker compose up --build --no-start`), so no docker call is made.",
        )
        .option(
          "--issue-id <ref>",
          "Issue ID in this machine's issue tracker (see `werkmeister machine setup`) " +
            "(env: WERKMEISTER_ISSUE_ID; config: issue_id).",
        )
        .option(
          "--project <name>",
          "The project (projects: in ~/.werkmeister/config.yaml) whose tracker holds the issue " +
            "(env: WERKMEISTER_PROJECT; config: project).",
        )
        .option(
          "--labels <list>",
          "Comma-separated free-form tags for filtering workspaces in the " +
            "dashboard search (env: WERKMEISTER_LABELS; config: labels).",
        )
        .option(
          "--test-path <path>",
          "URL path for feature testing (env: WERKMEISTER_TEST_PATH; config: test_path).",
        )
        .option(
          "--description <text>",
          "Free-form description for the CLAUDE.md header (env: WERKMEISTER_DESCRIPTION; config: description).",
        )
        .option(
          "--starting-prompt <text>",
          "First instruction for the agent; persisted to .werkmeister/workspace.yml " +
            "(env: WERKMEISTER_STARTING_PROMPT; config: starting_prompt).",
        )
        .addOption(
          new Option(
            "--work-type <type>",
            "Kind of work; seeds the first-phase handoff note " +
              "(env: WERKMEISTER_WORK_TYPE; config: work_type).",
          ).choices(["feature", "bugfix", "refactor", "spike", "incident"]),
        )
        .addOption(
          new Option(
            "--context-strategy <id>",
            "Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). " +
              "(env: WERKMEISTER_CONTEXT_STRATEGY; config: context_strategy).",
          ).choices([...STRATEGY_IDS]),
        )
        .option(
          "--autonomous",
          "Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a " +
            "headless session needs (env: WERKMEISTER_AUTONOMOUS; config: autonomous).",
        )
        .option(
          "--model <id>",
          "Claude model for this workspace's sessions: an alias (opus, sonnet, haiku) or a " +
            "claude-… id; blank keeps Claude Code's default (env: WERKMEISTER_MODEL; config: model).",
        )
        .option(
          "--auto-stop",
          "Stop this workspace's feature containers when a Claude session in it ends and no " +
            "other is open (a SessionEnd hook; env: WERKMEISTER_AUTO_STOP; config: auto_stop).",
        )
        .option(
          "--config <path>",
          "Path to a YAML config file (JSONC/JSON also accepted). Defaults " +
            "to <workspace>/.werkmeister/workspace.yml; legacy workspace.yaml / " +
            "workspace.jsonc / workspace.json are migrated on next write (env: " +
            "WERKMEISTER_WORKSPACE_CONFIG).",
        )
        .option(
          "--prune-context",
          "After a context_strategy change, delete the previous strategy's files that git " +
            "tracks unmodified (anything else is kept and reported).",
        )
        .option(
          "--refresh-issue",
          "Re-fetch the workspace's issue into .werkmeister/issue.md (BRIEF.md is not rewritten, except an untouched placeholder brief).",
        );
    },
    namespace: (_a, o) => ({
      task: o.task ?? null,
      feature: o.feature ?? null,
      services: o.services ?? null,
      repos: o.repos ?? null,
      force: Boolean(o.force),
      issue_id: o.issueId ?? null,
      project: o.project ?? null,
      labels: o.labels ?? null,
      test_path: o.testPath ?? null,
      description: o.description ?? null,
      starting_prompt: o.startingPrompt ?? null,
      work_type: o.workType ?? null,
      context_strategy: o.contextStrategy ?? null,
      autonomous: o.autonomous ?? null,
      model: o.model ?? null,
      auto_stop: o.autoStop ?? null,
      config_file: o.config ?? null,
      prune_context: Boolean(o.pruneContext),
      refresh_issue: Boolean(o.refreshIssue),
      build: o.build !== false,
    }),
  },
  {
    name: "budget status",
    group: "Machine:",
    help: "",
    load: () => import("./commands/budget.js"),
    configure: (cmd) => {
      cmd
        .description("Show the budget, the slots held and the features Waiting for room")
        .option("--json", "Print JSON");
    },
    namespace: (_a, o) => ({ json: Boolean(o.json) }),
  },
  ...(
    [
      ["status", "Say whether the daemon is serving and its launchd agent is current"],
      ["install", "Install or refresh the launchd agent (macOS)"],
      ["uninstall", "Remove the launchd agent; `infra connect` starts the daemon again"],
      ["restart", "Restart the daemon, through launchd when launchd owns it"],
    ] as const
  ).map(
    ([action, description]): CommandSpec => ({
      name: `daemon ${action}`,
      group: "Machine:",
      help: "",
      load: () => import("./commands/daemon.js"),
      configure: (cmd) => {
        cmd.description(description);
        if (action === "status") cmd.option("--json", "Print JSON");
      },
      namespace: (_a, o) => ({ action, json: Boolean(o.json) }),
    }),
  ),
  // SW-186 split these out of `stop`, `status` and `close-out`, whose specs above stay whole (deprecated).
  {
    name: "feature stop",
    group: "Features:",
    help: stopHelp,
    load: () => import("./commands/stop.js"),
    configure: (cmd) => {
      cmd
        .description("Stop containers without removing them or releasing the slot")
        .argument("[feature]", "Feature name. If omitted, read from FEATURE in a .env file.")
        // Internal: the child `internal session-end` spawns, which hands the stop to the host daemon (SW-184).
        .addOption(new Option("--via-daemon").hideHelp());
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      if_idle: false,
      idle: null,
      via_daemon: Boolean(o.viaDaemon),
    }),
  },
  {
    name: "feature status",
    group: "Features:",
    help: statusHelp,
    load: () => import("./commands/status.js"),
    configure: (cmd) => {
      cmd
        .description("Show all features, services, resource usage")
        .option("-v, --verbose", "Show individual container details")
        .option(
          "--intercepts",
          "Show Telepresence intercept state only (per feature service; cheap — skips docker and k8s probes).",
        )
        .option("--json", "Output structured JSON (useful for agent-driven diagnosis)");
    },
    namespace: (_a, o) => ({
      verbose: Boolean(o.verbose),
      k8s: false,
      intercepts: Boolean(o.intercepts),
      json: Boolean(o.json),
    }),
  },
  ...(["up", "down", "restart", "stop"] as const).map(
    (verb): CommandSpec => ({
      name: `infra ${verb}`,
      group: "Services and infra:",
      help: "",
      load: {
        up: () => import("./commands/up.js"),
        down: () => import("./commands/down.js"),
        restart: () => import("./commands/restart.js"),
        stop: () => import("./commands/stop.js"),
      }[verb],
      configure: (cmd) => {
        cmd.description(
          `${verb[0].toUpperCase()}${verb.slice(1)} the shared infrastructure (Caddy, k8s port-forwards)`,
        );
        if (verb === "down") cmd.option("-v, --volumes", "Also remove Docker volumes");
      },
      // The namespace `<verb> infra` produced before SW-186.
      namespace: (_a, o) =>
        ({
          up: { feature: "infra", workspace: null, dev: false },
          down: { feature: "infra", volumes: Boolean(o.volumes), all_features: false },
          restart: { feature: "infra" },
          stop: { feature: "infra", if_idle: false, idle: null, via_daemon: false },
        })[verb],
    }),
  ),
  {
    name: "infra status",
    group: "Services and infra:",
    help: "",
    load: () => import("./commands/status.js"),
    configure: (cmd) => {
      cmd
        .description("Show k8s port-forward health")
        .option("--json", "Output structured JSON (useful for agent-driven diagnosis)");
    },
    namespace: (_a, o) => ({ verbose: false, k8s: true, intercepts: false, json: Boolean(o.json) }),
  },
  {
    name: "workspace close",
    group: "Workspaces:",
    help: closeOutHelp,
    load: () => import("./commands/close_out.js"),
    configure: (cmd) => {
      cmd
        .description(
          "End a workspace after every PR shipped: close the issue, write closeout.md, remove the workspace, " +
            "delete merged branches. Refuses without postmortem.md (run the post-mortem first) unless " +
            "--skip-postmortem gives a reason",
        )
        .argument("[name]", "Workspace directory name; defaults to the workspace you are in")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--skip-postmortem <reason>",
          "Close out without a post-mortem; the reason goes in closeout.md",
        );
    },
    namespace: ([name], o) => ({
      name: name ?? null,
      yes: Boolean(o.yes),
      abandon: null,
      skipPostmortem: o.skipPostmortem ?? null,
    }),
  },
  {
    name: "workspace abandon",
    group: "Workspaces:",
    help: closeOutHelp,
    load: () => import("./commands/close_out.js"),
    configure: (cmd) => {
      cmd
        .description(
          "End a workspace without shipping: record the reason in closeout.md and the PR files, " +
            "push every branch and keep them, remove the workspace",
        )
        .argument("<reason>", "Why the work is abandoned")
        .argument("[name]", "Workspace directory name; defaults to the workspace you are in")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--skip-postmortem <reason>",
          "Close out without a post-mortem; the reason goes in closeout.md",
        );
    },
    namespace: ([reason, name], o) => ({
      name: name ?? null,
      yes: Boolean(o.yes),
      abandon: reason,
      skipPostmortem: o.skipPostmortem ?? null,
    }),
  },
  ...(
    [
      ["gate", "Deny or allow an Edit/Write per the standards gate"],
      ["pr-guard", "Deny opening a PR except via `werkmeister pr open`"],
      ["agent-state", "Record working / needs-you / done for the workspace pane and dashboard"],
    ] as const
  ).map(
    ([action, description]): CommandSpec => ({
      name: `internal ${action}`,
      group: "Internal:",
      help: action === "gate" ? hooksHelp : "",
      load: () => import("./commands/hooks.js"),
      configure: (cmd) => {
        cmd.description(`Claude Code hook: ${description}`);
      },
      namespace: () => ({ action }),
    }),
  ),
  {
    name: "internal session-end",
    group: "Internal:",
    help: "",
    load: () => import("./commands/stop.js"),
    configure: (cmd) => {
      cmd
        .description(
          "SessionEnd hook: stop the workspace's own feature unless another Claude session is " +
            "open there; silent, always exits 0, never stops infra",
        )
        // The child session-end spawns, which hands the stop to the host daemon (SW-184).
        .addOption(new Option("--via-daemon").hideHelp());
    },
    namespace: (_a, o) => ({
      feature: null,
      if_idle: true,
      idle: null,
      via_daemon: Boolean(o.viaDaemon),
    }),
  },
  {
    name: "internal reap",
    group: "Internal:",
    help: "",
    load: () => import("./commands/stop.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Stop every workspace's feature containers nothing has used for <minutes> (a busy or " +
            "recently active session, a gate exec or a fresh start all count as use)",
        )
        .argument("<minutes>", "Idle minutes before a feature is stopped")
        .argument("[feature]", "Only this feature");
    },
    namespace: ([minutes, feature]) => ({
      feature: feature ?? null,
      if_idle: false,
      idle: minutes,
      via_daemon: false,
    }),
  },
  ...(
    [
      ["gate", "Run the pre-PR gate", ["[repo]"], ["wait", "json"]],
      ["open", "Gate, push and open each approved PR file", ["[repo]"], ["wait", "json"]],
      ["status", "Record merged, shipped or closed for each PR file", ["[repo]"], ["json"]],
      ["adopt", "Record a PR opened outside the workspace", ["[pr]", "[repo]"], ["no-pr", "json"]],
      [
        "watch",
        "Resume each opening session once its PR merges, ships or closes (any workspace)",
        [],
        ["install", "json"],
      ],
      [
        "new",
        "Start a follow-up PR file and branch for a worktree whose PRs have merged",
        // Optional to commander: pr.ts prints the usage when it is missing.
        ["[worktree]"],
        ["slug", "json"],
      ],
    ] as const
  ).map(
    ([action, description, positionals, flags]): CommandSpec => ({
      name: `pr ${action}`,
      group: "PRs and issues:",
      help: "",
      load: () => import("./commands/pr.js"),
      configure: (cmd) => {
        cmd.description(description);
        const argHelp: Record<string, string> = {
          "[repo]":
            "Only this code worktree's PR files, or one PR file by its name (`werkmeister-why-page`)",
          "[pr]": "The PR number or URL",
          "[worktree]": "The code worktree the follow-up is for",
        };
        for (const p of positionals) cmd.argument(p, argHelp[p]);
        const has = (f: string) => (flags as readonly string[]).includes(f);
        if (has("slug"))
          cmd.option("--slug <slug>", "The follow-up's name, in its PR file and branch");
        if (has("no-pr")) cmd.option("--no-pr <reason>", "No PR — the fix is already on base");
        if (has("wait"))
          cmd.option(
            "--no-wait",
            "Don't wait for host load under budget.host_load before each check",
          );
        if (has("install"))
          cmd
            .option(
              "--install",
              "Install a schedule (launchd on macOS, else crontab) that runs `pr watch` every 10 minutes",
            )
            .option("--uninstall", "Remove that schedule");
        cmd.option("--json", "Print the result as JSON");
      },
      namespace: (positionals, o) => {
        const args = positionals.filter((a) => a != null) as string[];
        // Commander reads `--no-pr <reason>` as `pr`: true by default, the reason when given.
        const noPr = typeof o.pr === "string" ? o.pr : null;
        const pr = action === "adopt" && noPr === null ? (args[0] ?? null) : null;
        return {
          action,
          pr,
          noPr,
          repo: args[pr ? 1 : 0] ?? null,
          slug: o.slug ?? null,
          wait: o.wait !== false,
          json: Boolean(o.json),
          install: Boolean(o.install),
          uninstall: Boolean(o.uninstall),
        };
      },
    }),
  ),
  ...(
    [
      ["view", "Print the issue", ["json"]],
      ["update", "Change the issue's status and/or add a comment", ["status", "comment"]],
      [
        "create",
        "File a new issue and print its URL (Jira)",
        ["project", "type", "title", "body-file"],
      ],
      ["start", "Move the workspace's issue to in progress and fast-forward its worktrees", []],
      ["ready", "List a project's open work in priority order", ["project", "json"]],
    ] as const
  ).map(
    ([action, description, flags]): CommandSpec => ({
      name: `issue ${action}`,
      group: "PRs and issues:",
      help: "",
      load: () => import("./commands/issue.js"),
      configure: (cmd) => {
        cmd.description(description);
        if (action !== "create" && action !== "ready")
          cmd.argument(
            "[ref]",
            "Issue ID; omit inside a workspace to use its .werkmeister/workspace.yml issue",
          );
        const options: Record<string, [string, string]> = {
          json: ["--json", "Print JSON"],
          status: ["--status <name>", "Move the issue to this status"],
          comment: ["--comment <text>", "Add this comment"],
          project: [
            "--project <key>",
            action === "create"
              ? "The Jira project key to file in"
              : "A project from projects: in config.yaml",
          ],
          type: ["--type <type>", "bug, feature or task (mapped to the tracker's issue type)"],
          title: ["--title <text>", "The issue's summary"],
          "body-file": ["--body-file <path>", "The issue's description, from a file (- for stdin)"],
        };
        for (const f of flags) cmd.option(...options[f]);
      },
      namespace: ([ref], o) => ({
        action,
        ref: ref ?? null,
        json: Boolean(o.json),
        status: o.status ?? null,
        comment: o.comment ?? null,
        project: o.project ?? null,
        type: o.type ?? null,
        title: o.title ?? null,
        bodyFile: o.bodyFile ?? null,
      }),
    }),
  ),
];

async function dispatch(spec: CommandSpec, args: Namespace): Promise<void> {
  // SW-106 dropped the ~/.sandbox fallback: say so instead of running on an empty config. // name-check: ignore
  const home = os.homedir();
  if (
    spec.name !== "machine migrate" &&
    fs.existsSync(path.join(home, ".sandbox")) && // name-check: ignore
    !fs.existsSync(path.join(home, ".werkmeister"))
  ) {
    console.error(
      `${_RED}Found ~/.sandbox but no ~/.werkmeister: run 'werkmeister machine migrate' first.${_RESET}`, // name-check: ignore
    );
  }
  // One-shot migration: remove legacy ~/.werkmeister/slots.json on first run
  // after the labels refactor. Idempotent; no-op once the file is gone.
  try {
    const { migrateSlotsJson } = await import("werkmeister-core/slots");
    await migrateSlotsJson();
  } catch {
    // migration must never block the CLI
  }

  let mod: { run: (args: Namespace) => void | Promise<void> };
  try {
    mod = await spec.load(args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND") {
      console.log(`${_RED}Failed to load command '${spec.name}': ${(e as Error).message}${_RESET}`);
      process.exit(1);
    }
    throw e;
  }

  try {
    await mod.run(args);
  } catch (e) {
    // A `SandboxError` stands in for a site that printed `[err] <msg>` through
    // the reporter, so it goes back through the reporter; `WorkspaceError` is a
    // subclass whose ~45 sites have always printed `Error: <msg>`, so it stays
    // on the second branch.
    //
    // ponytail: every code exits 1, so there is no code → status table. Add one
    // when a code first needs a different status.
    if (e instanceof SandboxError && e.code !== WORKSPACE_ERROR_CODE) {
      error(e.message);
    } else {
      console.log(`${_RED}Error: ${(e as Error).message}${_RESET}`);
    }
    if (envVar("DEBUG")) {
      throw e;
    }
    process.exit(1);
  }
}

/**
 * `werkmeister __complete` — the callback behind bash's `complete -C`, which hands
 * us the line in COMP_LINE/COMP_POINT and reads newline-separated candidates
 * back off stdout. One code path covers bash and zsh (via bashcompinit), which
 * is why there is no generated per-shell completion script to keep in sync:
 * the candidates come straight off the commander program built above, so a new
 * entry in SPECS completes without touching anything here.
 *
 * Hook it up with (zsh needs the first line, bash does not):
 *     autoload -Uz +X bashcompinit && bashcompinit
 *     complete -C 'werkmeister __complete' werkmeister w9r
 */
async function completeLine(program: Command): Promise<void> {
  const line = (process.env.COMP_LINE ?? "").slice(0, Number(process.env.COMP_POINT ?? 0));
  const words = line.split(/\s+/);
  // A line ending in a space is starting a fresh word, not extending the last one.
  const current = line.endsWith(" ") ? "" : (words.pop() ?? "");
  const cmd = program.commands.find((c) => c.name() === words[1]);

  let candidates: string[] = [];
  if (!cmd) {
    candidates = program.commands.map((c) => c.name());
  } else if (current.startsWith("-")) {
    candidates = cmd.options.flatMap((o) => (o.long ? [o.long] : []));
  } else if (cmd.registeredArguments.length) {
    // ponytail: every positional completes as a feature name, so `logs
    // <feature> [service]` offers features in the service slot too, and the
    // list is the workspaces on disk rather than the features actually up
    // (that would be getAllSlots(), i.e. docker on every TAB). Split per
    // argument, or add the slot lookup, if either ever grates.
    candidates = ["infra"];
    try {
      const { listWorkspaces } = await import("werkmeister-core");
      const { workspaces } = await listWorkspaces();
      candidates.push(...workspaces.map((w) => w.name));
    } catch {
      // An unreadable workspaces root is not worth spilling an error message
      // into the user's completion buffer over.
    }
  }

  console.log(candidates.filter((c) => c.startsWith(current)).join("\n"));
}

export async function main(): Promise<void> {
  // Stands aside for a command that claims SIGINT to run its own cleanup first
  // — see lib/interrupt.ts for why this handler being registered first was a bug.
  installDefaultInterrupt(process, () => console.log(`\n${_RED}Interrupted${_RESET}`));

  const program = new Command();
  // Kept for `__reference`: commander keeps after-help text only as an event listener.
  const helpText = new Map<string, string>();
  const withHelp = (cmd: Command, key: string, text: string) => {
    helpText.set(key, text);
    cmd.addHelpText("after", `\n${text}`);
  };
  program
    .name("werkmeister")
    .description(BANNER)
    .version(JSON.parse(fs.readFileSync(path.join(_REPO_ROOT, "package.json"), "utf8")).version)
    .helpOption("-h, --help", "show this help message and exit");

  // `__parse <argv…>`: print the command and args namespace instead of running it, so a
  // test can pin every spelling's parse without docker or a workspace.
  const parseOnly = process.argv[2] === "__parse";
  if (parseOnly) process.argv.splice(2, 1);

  const nouns = new Map<string, Command>();
  const nounCommand = (noun: string, group: string): Command => {
    let cmd = nouns.get(noun);
    if (!cmd) {
      const meta = NOUNS[noun];
      if (!meta) throw new Error(`SPECS names unknown noun '${noun}'`);
      cmd = program
        .command(noun, { hidden: noun === "internal" })
        .helpGroup(group)
        .description(meta.description);
      if (meta.alias) cmd.alias(meta.alias);
      if (meta.help) withHelp(cmd, noun, meta.help);
      nouns.set(noun, cmd);
    }
    return cmd;
  };

  // `workspace <feature>` reached the default verb; `ws` is new, so only the old noun warns.
  const isImplicit = (noun: string, verb: string) => {
    const at = process.argv.indexOf(noun);
    return at >= 0 && process.argv[at + 1] !== verb;
  };

  // *warnAs* marks a hidden pre-SW-186 spelling: it warns on stderr (stdout carries
  // hook and --json output), then runs exactly what the new spelling runs.
  const addCommand = (
    parent: Command,
    spec: CommandSpec,
    name: string,
    warnAs?: (args: Namespace) => string,
  ) => {
    const cmd = parent.command(name, {
      hidden: Boolean(warnAs),
      isDefault: !warnAs && spec.isDefault,
    });
    if (parent === program && !warnAs) cmd.helpGroup(spec.group);
    if (spec.help) withHelp(cmd, warnAs ? name : spec.name, spec.help);
    spec.configure(cmd);
    cmd.action(async (...actionArgs) => {
      // commander passes (positional..., opts, command)
      const cmdObj = actionArgs.at(-1) as Command;
      const opts = cmdObj.opts();
      const positionals = actionArgs.slice(0, -2);
      const args = spec.namespace(positionals, opts);
      if (warnAs) console.error(deprecation(name, warnAs(args)));
      else if (spec.isDefault && isImplicit(parent.name(), name))
        console.error(deprecation(`${parent.name()} <feature>`, spec.name));
      if (parseOnly) {
        console.log(JSON.stringify({ command: spec.name, args }));
        return;
      }
      // One wrap per command: everything it and the library call print through
      // this reporter, and nothing outside a command has a sink at all.
      await withReporter(ttyReporter, () => dispatch(spec, args));
    });
  };

  const byGroup = [...SPECS].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
  for (const spec of byGroup) {
    const [noun, verb] = spec.name.split(" ");
    if (spec.deprecated) addCommand(program, spec, spec.name, spec.deprecated);
    else if (verb) addCommand(nounCommand(noun, spec.group), spec, verb);
    else addCommand(program, spec, spec.name);
    // `up infra` and the like moved to `infra <verb>`, not `feature <verb>`.
    const infraVerb = `infra ${verb}`;
    const hasInfraVerb = SPECS.some((s) => s.name === infraVerb);
    if (spec.old)
      addCommand(program, spec, spec.old, (a) =>
        hasInfraVerb && a.feature === "infra" ? infraVerb : spec.name,
      );
  }

  // `dashboard` and `mcp` name the two sibling apps, each with its own
  // dist/main.js. The ./werkmeister wrapper intercepts both before this file loads
  // (it is the only place that can resolve a node runtime), so these two
  // registrations exist for --help parity and to give a useful message to
  // anyone running dist/main.js directly. Neither takes a transport flag: the
  // wrapper launches `mcp` over stdio, and `werkmeister infra connect` starts the HTTP modes.
  for (const [name, description, help] of [
    [
      "dashboard",
      "Run the localhost workspaces dashboard in the foreground (checkout only)",
      dashboardHelp,
    ],
    [
      "mcp",
      "Launch the werkmeister MCP server over stdio (Claude Desktop, the werkmeister plugin; no token needed)",
      mcpHelp,
    ],
  ] as const) {
    // The pre-SW-186 spellings stay registered (hidden) so `node dist/main.js mcp` still explains itself.
    for (const [parent, key] of [
      [nounCommand("internal", "Internal:"), `internal ${name}`],
      [program, name],
    ] as const) {
      const cmd = parent.command(name, { hidden: parent === program }).description(description);
      withHelp(cmd, key, help);
      cmd.action(() => {
        // stderr, not stdout: an MCP client that got this far is reading stdout
        // as JSON-RPC, and printing English onto that channel is what made the
        // previous version of this stub look like a crashed server.
        console.error(
          `\`werkmeister ${key}\` launches a sibling app and must be run through the ` +
            "./werkmeister wrapper, which locates a node runtime and the app's entrypoint.",
        );
        process.exit(1);
      });
    }
  }

  program.commandsGroup("Internal:").helpCommand(true);

  if (process.argv[2] === "__complete") {
    return completeLine(program);
  }

  // SW-81: commander's model as JSON, for docs:gen's CLI reference and docs:check's flag list.
  if (process.argv[2] === "__reference") {
    // commander has no public getter for `.hidden`.
    const isHidden = (c: Command) => Boolean((c as unknown as { _hidden?: boolean })._hidden);
    const entry = (c: Command, name: string, group: string, hidden: boolean) => ({
      name,
      usage: c.usage().replace(/^\[options\] ?/, ""),
      description: c.description(),
      hidden,
      group,
      help: helpText.get(name) ?? "",
      options: c.options.map((o) => ({
        flags: o.flags,
        long: o.long,
        description: o.description,
        hidden: o.hidden,
      })),
    });
    // SW-186: one entry per `<noun> <verb>`; a noun gets its own entry only when it has a help.md (pr, issue).
    const reference = program.commands.flatMap((c) => {
      const self = entry(c, c.name(), c.helpGroup(), isHidden(c));
      if (!c.commands.length) return [self];
      const verbs = c.commands.map((v) =>
        entry(v, `${c.name()} ${v.name()}`, c.helpGroup(), isHidden(c) || isHidden(v)),
      );
      return helpText.has(c.name()) ? [self, ...verbs] : verbs;
    });
    console.log(JSON.stringify(reference));
    return;
  }

  // Not for hooks (`internal`, or `hooks` before SW-186): they run on every tool call,
  // and git would be a spawn each. Nor SessionEnd's stop, inside its exit budget.
  const hookCall =
    ["internal", "hooks"].includes(process.argv[2] ?? "") || process.argv.includes("--if-idle");
  if (!parseOnly && !hookCall) {
    const warning = staleBuildWarning(BUILD_STAMP, path.resolve(_REPO_ROOT, "../.."));
    if (warning) console.error(warning);
  }

  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exit(0);
  }

  await program.parseAsync(process.argv);
}

await main();
