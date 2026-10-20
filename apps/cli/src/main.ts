#!/usr/bin/env node
/**
 * Developer Sandbox CLI
 *
 * A multi-feature concurrent development orchestrator that lets up to 12
 * Claude Code agents develop features simultaneously. Each feature runs
 * only the services it modifies locally, with everything else
 * port-forwarded from k8s.
 *
 * Usage:
 *     sandbox up <feature|infra>               Start a feature or shared infra
 *     sandbox down <feature|infra> [-v]        Stop and clean up a feature or infra
 *     sandbox restart <feature|infra>          Restart containers
 *     sandbox stop <feature|infra>             Stop containers (preserve slot/volumes)
 *     sandbox status [--k8s]                   Show all active features; --k8s for k8s detail only
 *     sandbox detect [repo] [--dry-run] [--yes] [--assist|--no-assist]  Generate a repo's .sandbox/services.yaml
 *     sandbox services <feature>               List service endpoints
 *     sandbox logs <feature> [service]         Tail container logs
 *     sandbox remove <feature> <service>       Stop a local service (fall back to k8s)
 *     sandbox test <feature>                   Run Playwright tests
 *     sandbox open <feature> [--path P]        Open a feature-tagged Chrome window (sets X-Feature cookie)
 *     sandbox connect [--k8s]                  Start all shared infra; --k8s for k8s port-forwards only
 *     sandbox proxy-reload                     Regenerate and reload Caddy config
 *     sandbox clean [--all] [--dry-run]        Remove orphaned volumes and files
 *     sandbox stats [--collect N]              Show container resource usage
 *     sandbox optimize [--collect N]           Analyze usage vs limits, recommend changes
 *     sandbox workspace <feature> [opts]       Create a new workspace (worktrees + branch) and init it
 *     sandbox list-workspaces                  List workspaces under the workspaces root
 *     sandbox issue <view|update|create> [ref] Read, update or file an issue in the configured tracker
 *     sandbox remove-workspace <name>          Deprecated: use `sandbox close-out --abandon <reason>`
 *     sandbox pr <gate|open|status> [repo]     Pre-PR gate, open PRs from approved PR files, record merge/release
 *     sandbox close-out [name]                 End a workspace: after release, or with --abandon <reason>
 *     sandbox code [feature]                   Open a workspace in VS Code
 *     sandbox setup [--check]                  Install/update machine prerequisites (plugins + sandbox-workspace repo)
 *     sandbox registry [sync] [--check]        Regenerate ~/.sandbox/services.yaml from repo fragments
 *     sandbox dashboard                        Launch the workspace dashboard's MCP server (stdio)
 *     sandbox mcp                              Launch the headless remote MCP surface (stdio)
 *
 *     Feature name can be omitted if FEATURE is set in a .env file in the cwd.
 *     Use "infra" as the feature name to target shared infrastructure.
 */

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
import { BUILD_STAMP, staleBuildWarning } from "./lib/build_freshness.js";
import { installDefaultInterrupt } from "./lib/interrupt.js";

// Repo root (contains infra/, docs/, dist/). Exported as SANDBOX_ROOT for the
// config loaders.
const _REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!envVar("ROOT")) {
  process.env.SANDBOX_ROOT = _REPO_ROOT;
}

// ANSI helpers (duplicated here to stay import-light before dispatch)
const _RED = "\x1b[31m";
const _BOLD = "\x1b[1m";
const _RESET = "\x1b[0m";

const BANNER = `${_BOLD}Developer Sandbox CLI${_RESET}
Multi-feature concurrent development orchestrator
`;

/**
 * The parsed-argument bag handed to every command module's run().
 * Keys use snake_case names so command modules read
 * `args.issue_id` etc. verbatim.
 */
export type Namespace = Record<string, unknown>;

type CommandSpec = {
  name: string;
  /**
   * Import the command module. A thunk around a *literal* specifier, not a
   * `./commands/${name}.js` built from a string field: only the literal form is
   * resolved by tsc and by the esbuild bundle the published package ships
   * (note 038 — a computed specifier compiles and bundles clean while resolving
   * nowhere, which is how the same class of bug survived three PRs).
   */
  load: () => Promise<{ run: (args: Namespace) => void | Promise<void> }>;
  configure: (cmd: Command) => void;
  // Map commander (positionals, opts) → the args namespace.
  namespace: (args: unknown[], opts: Record<string, unknown>) => Namespace;
};

const SPECS: CommandSpec[] = [
  {
    name: "up",
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
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      workspace: o.workspace ?? null,
      dev: o.dev ?? false,
    }),
  },
  {
    name: "down",
    load: () => import("./commands/down.js"),
    configure: (cmd) => {
      cmd
        .description("Stop containers, release slot, update proxy (use 'infra' for shared infra)")
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
    name: "intercept",
    load: () => import("./commands/intercept.js"),
    configure: (cmd) => {
      cmd
        .description("Route header-scoped k8s dev traffic to a local service (Telepresence OSS).")
        .argument("[feature]", "Feature name (defaults to FEATURE from a .env file in CWD).")
        .option(
          "-s, --service <name>",
          "Local service to intercept (must be in the workspace's SERVICES and running via `sandbox up`).",
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
    name: "restart",
    load: () => import("./commands/restart.js"),
    configure: (cmd) => {
      cmd
        .description("Restart containers (use 'infra' for shared infra)")
        .argument(
          "[feature]",
          "Feature name or 'infra'. If omitted, read from FEATURE in a .env file.",
        );
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "stop",
    load: () => import("./commands/stop.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Stop containers without removing them or releasing the slot (use 'infra' for shared infra)",
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
        );
    },
    namespace: ([feature], o) => ({
      feature: feature ?? null,
      if_idle: Boolean(o.ifIdle),
      idle: o.idle ?? null,
    }),
  },
  {
    name: "status",
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
    name: "detect",
    load: () => import("./commands/detect.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Generate <repo>/.sandbox/services.yaml from the repo's package manifests, " +
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
    name: "services",
    load: () => import("./commands/services.js"),
    configure: (cmd) => {
      cmd
        .description("List services and their endpoints for a feature")
        .argument("<feature>", "Feature name");
    },
    namespace: ([feature]) => ({ feature }),
  },
  {
    name: "logs",
    load: () => import("./commands/logs.js"),
    configure: (cmd) => {
      cmd
        .description("Tail docker compose logs for a feature")
        .argument("<feature>", "Feature name")
        .argument("[service]", "Specific service to tail (optional)");
    },
    namespace: ([feature, service]) => ({ feature, service: service ?? null }),
  },
  {
    name: "remove",
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
    name: "test",
    load: () => import("./commands/test.js"),
    configure: (cmd) => {
      cmd
        .description("Run Playwright tests against a feature's stack")
        .argument("<feature>", "Feature name")
        .argument("[extra...]", "Additional arguments to pass to Playwright");
    },
    namespace: ([feature, extra]) => ({ feature, extra: extra ?? [] }),
  },
  {
    name: "open",
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
            "(default: test_path from .sandbox/workspace.yml, else TEST_PATH from .env, else '/').",
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
    name: "connect",
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
    name: "proxy-reload",
    load: () => import("./commands/proxy_reload.js"),
    configure: (cmd) => {
      cmd.description("Regenerate Caddyfile and reload Caddy");
    },
    namespace: () => ({}),
  },
  {
    name: "clean",
    load: () => import("./commands/clean.js"),
    configure: (cmd) => {
      cmd
        .description("Remove orphaned volumes and generated files from stopped features")
        .option(
          "--all",
          "Also clean volumes for currently active features (implies sandbox down for each)",
        )
        .option("--dry-run", "Show what would be cleaned without actually removing anything");
    },
    namespace: (_a, o) => ({ all: Boolean(o.all), dry_run: Boolean(o.dryRun) }),
  },
  {
    name: "stats",
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
    name: "optimize",
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
    load: () => import("./commands/skills.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Workspace sb-* skill projection: verify freshness against the " +
            "sandbox repo (check) or rewrite it (sync)",
        )
        .addArgument(
          new Argument(
            "<action>",
            "check: exit 1 if the workspace's .claude/skills/sb-* lag the repo; sync: refresh them",
          ).choices(["check", "sync"]),
        );
    },
    namespace: ([action]) => ({ action }),
  },
  {
    name: "standards",
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
    load: () => import("./commands/hooks.js"),
    configure: (cmd) => {
      cmd
        .description("PreToolUse hook entrypoints: the standards gate and the PR guard")
        .addArgument(
          new Argument(
            "<action>",
            "gate: deny or allow an Edit/Write per the standards gate; pr-guard: deny opening a PR except via `sandbox pr open`",
          ).choices(["gate", "pr-guard"]),
        );
    },
    namespace: ([action]) => ({ action }),
  },
  {
    name: "notes",
    load: () => import("./commands/notes.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Workspace notes (.sandbox/notes/). `context` prints the latest " +
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
    name: "workspace",
    load: () => import("./commands/workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Create a new workspace under $SANDBOX_WORKSPACES_ROOT (git worktrees " +
            "on a <user>/<workspace> branch) and run init-workspace inside it.",
        )
        .argument(
          "[feature]",
          "Feature name (lower-cased). Combined with --issue-id to form the " +
            "workspace dir name, e.g. an issue + feature -> <issue-slug>-feature. " +
            "If omitted, resolved from ./.sandbox/workspace.yml, then interactively (TTY).",
        )
        .option(
          "--issue-id <ref>",
          "Issue ID in this machine's issue tracker (see `sandbox setup`). Its slug is " +
            "prefixed to the workspace dir name; passed through to init-workspace.",
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
              "(env: SANDBOX_CONTEXT_STRATEGY; config: context_strategy).",
          ).choices([...STRATEGY_IDS]),
        )
        .option(
          "--autonomous",
          "Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a " +
            "headless session needs (env: SANDBOX_AUTONOMOUS; config: autonomous).",
        )
        .option(
          "--model <id>",
          "Claude model for this workspace's sessions: an alias (opus, sonnet, haiku) or a " +
            "claude-… id; blank keeps Claude Code's default (env: SANDBOX_MODEL; config: model).",
        )
        .option(
          "--auto-stop",
          "Stop this workspace's feature containers when a Claude session in it ends and no " +
            "other is open (a SessionEnd hook; env: SANDBOX_AUTO_STOP; config: auto_stop).",
        )
        .option(
          "--browser-form",
          "Collect inputs through the Sandbox-branded browser form (the same " +
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
    name: "list-workspaces",
    load: () => import("./commands/list_workspaces.js"),
    configure: (cmd) => {
      cmd.description("List the workspaces under the workspaces root with their issue and labels");
    },
    namespace: () => ({}),
  },
  {
    name: "issue",
    load: () => import("./commands/issue.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Read, update or file an issue in this machine's issue tracker (see `sandbox setup`)",
        )
        .addArgument(
          new Argument(
            "<action>",
            "view: print the issue; update: change its status and/or add a comment; create: file a new issue and print its URL (Jira); start: move the workspace's issue to in progress (forward only)",
          ).choices(["view", "update", "create", "start"]),
        )
        .argument(
          "[ref]",
          "Issue ID; omit inside a workspace to use its .sandbox/workspace.yml issue",
        )
        .option("--json", "view: print the issue as JSON")
        .option("--status <name>", "update: move the issue to this status")
        .option("--comment <text>", "update: add this comment")
        .option("--project <key>", "create: the Jira project to file in")
        .option(
          "--type <type>",
          "create: bug, feature or task (mapped to the tracker's issue type)",
        )
        .option("--title <text>", "create: the issue's summary")
        .option("--body-file <path>", "create: the issue's description, from a file (- for stdin)");
    },
    namespace: ([action, ref], o) => ({
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
  },
  {
    name: "remove-workspace",
    load: () => import("./commands/remove_workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Deprecated: use `sandbox close-out --abandon <reason>`. Hand off (commit + push) and delete a workspace",
        )
        .argument("<name>", "Workspace directory name, as `sandbox list-workspaces` reports it")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--abandon <reason>",
          "Remove despite unshipped work; records the reason in closeout.md and the PR files",
        );
    },
    namespace: ([name], o) => ({ name, yes: Boolean(o.yes), abandon: o.abandon ?? null }),
  },
  {
    name: "pr",
    load: () => import("./commands/pr.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Open and track this workspace's PRs from its PR files (docs/workspace-lifecycle.md)",
        )
        .addArgument(
          new Argument(
            "<action>",
            "gate: run the pre-PR gate; open: gate, push and open each approved PR file; status: record merged/shipped/closed; adopt: record a PR opened outside the workspace; watch: resume each opening session once its PR merges, ships or closes (any workspace; `--install` schedules it)",
          ).choices(["gate", "open", "status", "adopt", "watch"]),
        )
        .argument(
          "[args...]",
          "[repo] — only this code worktree's PR file; adopt: <pr-number|url> [repo]",
        )
        .option("--no-pr <reason>", "adopt: no PR — the fix is already on base")
        .option(
          "--install",
          "watch: install a schedule (launchd on macOS, else crontab) that runs `pr watch` every 10 minutes",
        )
        .option("--uninstall", "watch: remove that schedule")
        .option("--json", "Print the result as JSON");
    },
    namespace: ([action, rest], o) => {
      const args = rest as string[];
      // Commander reads `--no-pr <reason>` as `pr`: true by default, the reason when given.
      const noPr = typeof o.pr === "string" ? o.pr : null;
      const pr = action === "adopt" && noPr === null ? (args[0] ?? null) : null;
      return {
        action,
        pr,
        noPr,
        repo: args[pr ? 1 : 0] ?? null,
        json: Boolean(o.json),
        install: Boolean(o.install),
        uninstall: Boolean(o.uninstall),
      };
    },
  },
  {
    name: "close-out",
    load: () => import("./commands/close_out.js"),
    configure: (cmd) => {
      cmd
        .description(
          "End a workspace. After every PR shipped: close the issue, write closeout.md, remove the workspace, delete merged branches. " +
            "With --abandon: record the reason, push every branch and keep them, remove the workspace",
        )
        .argument("[name]", "Workspace directory name; defaults to the workspace you are in")
        .option("-y, --yes", "Skip the confirmation prompt")
        .option(
          "--abandon <reason>",
          "Close out without shipping; the reason goes in closeout.md and the PR files",
        );
    },
    namespace: ([name], o) => ({
      name: name ?? null,
      yes: Boolean(o.yes),
      abandon: o.abandon ?? null,
    }),
  },
  {
    name: "code",
    load: () => import("./commands/code.js"),
    configure: (cmd) => {
      cmd
        .description("Open a workspace in VS Code")
        .argument(
          "[feature]",
          "Workspace name, as `sandbox list-workspaces` reports it. If omitted, read from FEATURE in a .env file.",
        );
    },
    namespace: ([feature]) => ({ feature: feature ?? null }),
  },
  {
    name: "setup",
    load: () => import("./commands/setup.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Guided machine setup: walks through paths, ingress domains and the " +
            "~/.sandbox service registry, then converges the plugins, the " +
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
    name: "config",
    load: () => import("./commands/config.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Set up and maintain the machine-global sandbox config " +
            "(~/.sandbox/config.yaml — the single source of truth); regenerates " +
            "env.sh and wires up ~/.zshenv and the Desktop MCP config",
        )
        .option(
          "--repos-root <path>",
          "Absolute path to the canonical source-repo clones (non-interactive set).",
        )
        .option(
          "--workspaces-root <path>",
          "Absolute path to the per-feature worktree workspaces (non-interactive set).",
        )
        .option("--show", "Print the resolved config and each value's origin, without writing.")
        .option("--check", "Validate config + derived files; nonzero exit on drift.");
    },
    namespace: (_a, o) => ({
      repos_root: o.reposRoot ?? null,
      workspaces_root: o.workspacesRoot ?? null,
      show: Boolean(o.show),
      check: Boolean(o.check),
    }),
  },
  {
    name: "registry",
    load: () => import("./commands/registry.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Regenerate ~/.sandbox/services.yaml from every <repo>/.sandbox/services.yaml " +
            "under paths.repos_root (merged under ~/.sandbox/services.local.yaml)",
        )
        .argument("[action]", "sync — the default and only action")
        .option("--check", "Report drift without writing; nonzero exit when stale.");
    },
    namespace: ([action], o) => ({ action: action ?? "sync", check: Boolean(o.check) }),
  },
  {
    name: "init-workspace",
    load: () => import("./commands/init_workspace.js"),
    configure: (cmd) => {
      cmd
        .description(
          "Reconcile a sandbox workspace from .sandbox/workspace.yml: create/remove " +
            "repo worktrees to match the `repos`/`services` fields, then (re)generate " +
            `CLAUDE.md / .env / ${COMPOSE_FILE}. Idempotent — edit workspace.yml and ` +
            "rerun. Inputs resolve as CLI flag > env (SANDBOX_*) > workspace.yml.",
        )
        .option("-t, --task <title>", "Task description / title (env: SANDBOX_TASK; config: task).")
        .option("--feature <name>", "Feature name for sandbox slot routing (config: feature).")
        .option(
          "--services <list>",
          "Comma-separated list of local services (env: SANDBOX_SERVICES; config: services). " +
            "Their owning repos are added to the reconciled worktree set.",
        )
        .option(
          "-r, --repos <list>",
          "Comma-separated repos to keep as git worktrees (union with the repos " +
            "owning --services). Persisted to workspace.yml; the worktree set is reconciled " +
            "to match on every run (env: SANDBOX_REPOS; config: repos).",
        )
        .option(
          "--force",
          "When reconciling, delete repo worktrees dropped from workspace.yml even if " +
            "they have uncommitted changes, and delete a <user>/<workspace> branch an earlier " +
            "workspace left on origin instead of aborting (default: abort without changes).",
        )
        .option(
          "--issue-id <ref>",
          "Issue ID in this machine's issue tracker (see `sandbox setup`) " +
            "(env: SANDBOX_ISSUE_ID; config: issue_id).",
        )
        .option(
          "--labels <list>",
          "Comma-separated free-form tags for filtering workspaces in the " +
            "dashboard search (env: SANDBOX_LABELS; config: labels).",
        )
        .option(
          "--test-path <path>",
          "URL path for feature testing (env: SANDBOX_TEST_PATH; config: test_path).",
        )
        .option(
          "--description <text>",
          "Free-form description for the CLAUDE.md header (env: SANDBOX_DESCRIPTION; config: description).",
        )
        .option(
          "--starting-prompt <text>",
          "First instruction for the agent; persisted to .sandbox/workspace.yml " +
            "(env: SANDBOX_STARTING_PROMPT; config: starting_prompt).",
        )
        .addOption(
          new Option(
            "--work-type <type>",
            "Kind of work; seeds the first-phase handoff note " +
              "(env: SANDBOX_WORK_TYPE; config: work_type).",
          ).choices(["feature", "bugfix", "refactor", "spike", "incident"]),
        )
        .addOption(
          new Option(
            "--context-strategy <id>",
            "Context layer to generate: jit (skills, hooks, notes) or icm (staged folders). " +
              "(env: SANDBOX_CONTEXT_STRATEGY; config: context_strategy).",
          ).choices([...STRATEGY_IDS]),
        )
        .option(
          "--autonomous",
          "Run an icm workspace stage-to-PR with no human checks, and allow the Bash calls a " +
            "headless session needs (env: SANDBOX_AUTONOMOUS; config: autonomous).",
        )
        .option(
          "--model <id>",
          "Claude model for this workspace's sessions: an alias (opus, sonnet, haiku) or a " +
            "claude-… id; blank keeps Claude Code's default (env: SANDBOX_MODEL; config: model).",
        )
        .option(
          "--auto-stop",
          "Stop this workspace's feature containers when a Claude session in it ends and no " +
            "other is open (a SessionEnd hook; env: SANDBOX_AUTO_STOP; config: auto_stop).",
        )
        .option(
          "--config <path>",
          "Path to a YAML config file (JSONC/JSON also accepted). Defaults " +
            "to <workspace>/.sandbox/workspace.yml; legacy workspace.yaml / " +
            "workspace.jsonc / workspace.json are migrated on next write (env: " +
            "SANDBOX_WORKSPACE_CONFIG).",
        )
        .option(
          "--prune-context",
          "After a context_strategy change, delete the previous strategy's files that git " +
            "tracks unmodified (anything else is kept and reported).",
        )
        .option(
          "--refresh-issue",
          "Re-fetch the workspace's issue into .sandbox/issue.md (BRIEF.md is not rewritten, except an untouched placeholder brief).",
        );
    },
    namespace: (_a, o) => ({
      task: o.task ?? null,
      feature: o.feature ?? null,
      services: o.services ?? null,
      repos: o.repos ?? null,
      force: Boolean(o.force),
      issue_id: o.issueId ?? null,
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
    }),
  },
];

async function dispatch(spec: CommandSpec, args: Namespace): Promise<void> {
  // One-shot migration: remove legacy ~/.sandbox/slots.json on first run
  // after the labels refactor. Idempotent; no-op once the file is gone.
  try {
    const { migrateSlotsJson } = await import("werkmeister-core/slots");
    await migrateSlotsJson();
  } catch {
    // migration must never block the CLI
  }

  let mod: { run: (args: Namespace) => void | Promise<void> };
  try {
    mod = await spec.load();
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
 * `sandbox __complete` — the callback behind bash's `complete -C`, which hands
 * us the line in COMP_LINE/COMP_POINT and reads newline-separated candidates
 * back off stdout. One code path covers bash and zsh (via bashcompinit), which
 * is why there is no generated per-shell completion script to keep in sync:
 * the candidates come straight off the commander program built above, so a new
 * entry in SPECS completes without touching anything here.
 *
 * Hook it up with (zsh needs the first line, bash does not):
 *     autoload -Uz +X bashcompinit && bashcompinit
 *     complete -C 'sandbox __complete' sandbox
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
  program
    .name("werkmeister")
    .description(BANNER)
    .helpOption("-h, --help", "show this help message and exit");

  for (const spec of SPECS) {
    const cmd = program.command(spec.name);
    spec.configure(cmd);
    cmd.action(async (...actionArgs) => {
      // commander passes (positional..., opts, command)
      const cmdObj = actionArgs.at(-1) as Command;
      const opts = cmdObj.opts();
      const positionals = actionArgs.slice(0, -2);
      // One wrap per command: everything it and the library call print through
      // this reporter, and nothing outside a command has a sink at all.
      await withReporter(ttyReporter, () => dispatch(spec, spec.namespace(positionals, opts)));
    });
  }

  // `dashboard` and `mcp` name the two sibling apps, each with its own
  // dist/main.js. The ./werkmeister wrapper intercepts both before this file loads
  // (it is the only place that can resolve a node runtime), so these two
  // registrations exist for --help parity and to give a useful message to
  // anyone running dist/main.js directly. Neither takes a transport flag: the
  // wrapper launches `mcp` over stdio, and `sandbox connect` starts the HTTP modes.
  for (const [name, description] of [
    ["dashboard", "Run the localhost workspaces dashboard in the foreground (checkout only)"],
    [
      "mcp",
      "Launch the werkmeister MCP server over stdio (Claude Desktop, the werkmeister plugin; no token needed)",
    ],
  ] as const) {
    program
      .command(name)
      .description(description)
      .action(() => {
        // stderr, not stdout: an MCP client that got this far is reading stdout
        // as JSON-RPC, and printing English onto that channel is what made the
        // previous version of this stub look like a crashed server.
        console.error(
          `\`werkmeister ${name}\` launches a sibling app and must be run through the ` +
            "./werkmeister wrapper, which locates a node runtime and the app's entrypoint.",
        );
        process.exit(1);
      });
  }

  if (process.argv[2] === "__complete") {
    return completeLine(program);
  }

  // Not for `hooks`: they run on every tool call, and git would be a spawn each.
  // Not for `stop --if-idle` either: it runs inside SessionEnd's exit budget.
  if (process.argv[2] !== "hooks" && !process.argv.includes("--if-idle")) {
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
