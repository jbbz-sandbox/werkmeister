/**
 * The headless tool registrations: the verbs the CLI also has. The tools that
 * came from the dashboard (PRs, issues, sessions, the `ui://` App tools) are in
 * workspace_tools.ts.
 *
 * Every one is a thin adapter: validate with zod, call the core function inside
 * a collecting reporter, return the transcript as `content` and the typed
 * result as `structuredContent`. Nothing here decides anything a verb should
 * decide — if a registration grows a branch about *what the verb does*, that
 * logic belongs in `werkmeister-core` (predecessor spec §4).
 */

import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { closeOut, resumeAndNudge } from "werkmeister-core";

import { launchFeatureWindow, readWorkspaceYaml } from "werkmeister-core/browser";
import { composeLogs } from "werkmeister-core/compose";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import { getReposRoot, servicesLocalYamlPath } from "werkmeister-core/config";
import { SandboxError } from "werkmeister-core/errors";
import { featureUrl } from "werkmeister-core/feature_routing";
import {
  applyAnswers,
  collectQuestions,
  planFragment,
  planSummary,
  portsPerSlot,
  renderFragment,
  stdoutRunner,
  validateFragment,
  writeFragment,
} from "werkmeister-core/fragment_detect";
import { graduateNote } from "werkmeister-core/graduate";
import { connectK8s, up as infraUp } from "werkmeister-core/infra";
import {
  down,
  pause,
  readServicesFromWorkspace,
  reloadProxy,
  removeService,
  restart,
  stop,
  up,
} from "werkmeister-core/lifecycle";
import { listNotes, parseNote } from "werkmeister-core/notes";
import { collectingReporter, raw, withReporter } from "werkmeister-core/reporter";
import { featureServices } from "werkmeister-core/slots";
import { checkStandards } from "werkmeister-core/standards";
import { STRATEGY_IDS, strategyFor } from "werkmeister-core/strategies";
import { leaveIntercept, startIntercept } from "werkmeister-core/telepresence";
import { runFeatureTests } from "werkmeister-core/test_run";
import { initWorkspace } from "werkmeister-core/workspace_init";
import { z } from "zod";
import { type ReqHeaders, resolveFeature, resolveWorkspace } from "./lib/feature.js";

/**
 * What the SDK hands a tool handler. `signal` is aborted when the request is
 * cancelled OR the transport closes, so it is the client-disconnected signal;
 * `requestInfo` carries the original HTTP headers, which is where the feature
 * comes from.
 */
type Extra = {
  signal: AbortSignal;
  requestInfo?: { headers: Record<string, string | string[] | undefined> };
};

export const headersOf = (extra: unknown): ReqHeaders => (extra as Extra).requestInfo?.headers;

/**
 * Run one core call and shape it into a tool result.
 *
 * `content` is the transcript the CLI would have printed for that verb,
 * character for character — that is what makes this surface legible to an agent
 * without twenty renderers here. `structuredContent` is the typed result,
 * verbatim. The reporter is AsyncLocalStorage-scoped, so concurrent tool calls
 * do not interleave and no correlation id is needed.
 *
 * `passthrough` is false on this reporter (collectingReporter's default) and
 * must stay false: on `--stdio` this process's stdout is the JSON-RPC channel.
 */
async function adapt(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  const reporter = collectingReporter();
  try {
    const structuredContent = await withReporter(reporter, fn);
    return { content: [{ type: "text", text: reporter.text() }], structuredContent };
  } catch (e) {
    if (e instanceof SandboxError) {
      // The codes (NOT_RUNNING, WORKSPACE, …) are the remote analogue of the
      // CLI's exit codes: something for the caller to branch on.
      return {
        isError: true,
        content: [{ type: "text", text: `${e.message}\n\n${reporter.text()}` }],
        structuredContent: { code: e.code },
      };
    }
    // Anything else is unexpected, and the transcript is usually the only
    // diagnosis there is.
    return {
      isError: true,
      content: [{ type: "text", text: `${(e as Error).message}\n\n${reporter.text()}` }],
    };
  }
}

/**
 * The one identifier every workspace-scoped tool shares: optional, defaulting
 * to the connection's `X-Sandbox-Feature` header (lib/feature.ts).
 */
export const WORKSPACE_ARG = {
  workspace: z
    .string()
    .optional()
    .describe(
      "Workspace directory name (as list-workspaces reports it) or feature name. " +
        "Defaults to the X-Sandbox-Feature header on the connection.",
    ),
};

export function registerTools(server: McpServer): void {
  registerLifecycleTools(server);
  registerAuthoringTools(server);
  registerHostTools(server);
}

// ---------------------------------------------------------------------------
// Lifecycle and inspection
// ---------------------------------------------------------------------------

function registerLifecycleTools(server: McpServer): void {
  server.registerTool(
    "up",
    {
      title: "Bring a feature up",
      description:
        "Allocate the feature's slot, start its containers, and point the reverse proxy at " +
        "them. Returns the slot, port range, local services and their URLs.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature, dir } = resolveFeature(args.workspace, headersOf(extra));
        return { ...(await up(feature, dir, { signal: extra.signal })) };
      }),
  );

  server.registerTool(
    "down",
    {
      title: "Tear a feature down",
      description:
        "Leave the feature's k8s intercepts, remove its containers, release its slot, and " +
        "reload the reverse proxy so nothing routes to the removed containers.",
      inputSchema: {
        ...WORKSPACE_ARG,
        removeVolumes: z
          .boolean()
          .optional()
          .describe("Also remove the feature's named volumes. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature } = resolveFeature(args.workspace, headersOf(extra));
        const result = await down(feature, {
          removeVolumes: args.removeVolumes ?? false,
          signal: extra.signal,
        });
        // As the CLI does: down() leaves Caddy routing to containers that are gone.
        return { ...result, proxy: await reloadProxy() };
      }),
  );

  server.registerTool(
    "stop",
    {
      title: "Stop a feature's containers",
      description:
        "Stop the containers, leaving them and the slot in place so restart or " +
        "up can resume the feature.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await stop(resolveFeature(args.workspace, headersOf(extra)).feature)),
      })),
  );

  server.registerTool(
    "pause",
    {
      title: "Pause a workspace",
      description:
        "Pause a workspace: freeze its containers and hold its Claude session until resume.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await pause(resolveFeature(args.workspace, headersOf(extra)).feature)),
      })),
  );

  server.registerTool(
    "resume",
    {
      title: "Resume a paused workspace",
      description:
        "Resume a paused workspace: thaw exactly the containers paused, release its Claude " +
        "session, and tell it to continue if Pause cut a turn.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const ws = resolveFeature(args.workspace, headersOf(extra));
        return { ...(await resumeAndNudge(ws.name, ws.dir, ws.feature)) };
      }),
  );

  server.registerTool(
    "restart",
    {
      title: "Restart a feature's containers",
      description: "Bounce the feature's containers, reusing its slot.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await restart(resolveFeature(args.workspace, headersOf(extra)).feature)),
      })),
  );

  server.registerTool(
    "detect",
    {
      title: "Generate a repo's service-registry fragment",
      description:
        "Scan a repo (package manifests, Dockerfiles, compose, Helm, k8s, kustomize) and propose its " +
        ".werkmeister/services.yaml. Returns the report, the proposed YAML and the questions the scan could " +
        "not settle. Writes only with write: true. Answer questions by passing `answers` " +
        "({ item: <question id>, value, reason, files_read }); answers can only fill those questions.",
      inputSchema: {
        repo: z
          .string()
          .describe("Repo directory name under paths.repos_root, or an absolute path."),
        write: z
          .boolean()
          .optional()
          .describe("Write the fragment when it is valid and something changed."),
        answers: z
          .array(
            z.object({
              item: z.string(),
              value: z.unknown(),
              reason: z.string(),
              files_read: z.array(z.string()).default([]),
            }),
          )
          .optional(),
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => {
        const reposRoot = getReposRoot();
        const root = path.isAbsolute(args.repo) ? args.repo : path.join(reposRoot, args.repo);
        let plan = planFragment(root, {
          reposRoot,
          runner: stdoutRunner,
          localPath: servicesLocalYamlPath(),
          portsPerSlot: portsPerSlot(),
        });
        const applied = args.answers?.length ? applyAnswers(plan, args.answers) : null;
        if (applied) plan = applied.plan;
        const rendered = renderFragment(plan);
        const errors = rendered.changed ? validateFragment(rendered, plan, reposRoot) : [];
        const wrote = Boolean(args.write) && rendered.changed && errors.length === 0;
        if (wrote) writeFragment(rendered);
        return {
          path: rendered.path,
          wrote,
          changed: rendered.changed,
          added: rendered.added,
          skipped: rendered.skipped,
          errors,
          yaml: rendered.yaml,
          report: planSummary(plan),
          questions: collectQuestions(plan),
          accepted: applied?.accepted ?? [],
          rejected: applied?.rejected ?? [],
        };
      }),
  );

  server.registerTool(
    "services",
    {
      title: "Where a feature's services answer",
      description:
        "Every registered service and its endpoint for this feature — local container, k8s " +
        "forward, or not configured.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await featureServices(resolveFeature(args.workspace, headersOf(extra)).feature)),
      })),
  );

  server.registerTool(
    "logs",
    {
      title: "Read a feature's container logs",
      description:
        "A bounded read of the feature's container logs, optionally one service. This " +
        "is not a subscription: it never follows, and returns the last `tail` lines.",
      inputSchema: {
        ...WORKSPACE_ARG,
        service: z.string().optional().describe("Limit to one service's container."),
        tail: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Lines of history to return. Default 200."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature } = resolveFeature(args.workspace, headersOf(extra));
        const service = args.service ?? null;
        const tail = args.tail ?? 200;
        // follow: false is what makes this return at all; the signal still
        // covers a client that hangs up mid-read.
        // Collected separately so the lines also reach structuredContent: the
        // dashboard's HostBridge reads only that (SW-53).
        const logs = collectingReporter();
        await withReporter(logs, () =>
          composeLogs(feature, service, { follow: false, tail, signal: extra.signal }),
        );
        raw(logs.text());
        return { feature, service, tail, output: logs.text() };
      }),
  );

  server.registerTool(
    "remove-service",
    {
      title: "Drop a service from a feature",
      description:
        "Remove one service from the feature's local services so it falls back to k8s: " +
        "regenerate the workspace files, restart (or stop) the containers, re-point the proxy.",
      inputSchema: {
        ...WORKSPACE_ARG,
        service: z.string().describe("The local service to drop."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await removeService(
          resolveFeature(args.workspace, headersOf(extra)).feature,
          args.service,
        )),
      })),
  );

  server.registerTool(
    "test",
    {
      title: "Run a feature's Playwright suite",
      description:
        "Run the feature's Playwright tests with SANDBOX_FEATURE set, so the suite carries the " +
        "X-Feature routing cookie. Runs only when the workspace has a Playwright config; otherwise nothing runs " +
        "and `message` lists each service's test command and validation guidance. " +
        "A failing suite is a result (non-zero `status`), not an error.",
      inputSchema: {
        ...WORKSPACE_ARG,
        extraArgs: z
          .array(z.string())
          .optional()
          .describe("Extra arguments appended to `npx playwright test`."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature, dir } = resolveFeature(args.workspace, headersOf(extra));
        return {
          ...(await runFeatureTests({
            feature,
            workspace: dir,
            extraArgs: args.extraArgs ?? [],
            signal: extra.signal,
          })),
        };
      }),
  );

  server.registerTool(
    "proxy-reload",
    {
      title: "Regenerate and reload the reverse proxy",
      description:
        "Rebuild the Caddyfile from the active features and hand it to Caddy, starting Caddy if " +
        "it is down. Call this after tearing features down.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => ({ ...(await reloadProxy({ start: true })) })),
  );
}

// ---------------------------------------------------------------------------
// Workspace authoring
// ---------------------------------------------------------------------------

/**
 * The wizard's fields as tool arguments, so a reconcile never blocks on a
 * terminal prompt that does not exist.
 */
const WORKSPACE_FIELDS = {
  repos: z.string().optional().describe("Comma-separated repos to check out."),
  services: z.string().optional().describe("Comma-separated services to run locally."),
  issue_id: z
    .string()
    .optional()
    .describe("Issue ID or URL in this machine's issue tracker (see `sandbox setup`)."),
  work_type: z.string().optional().describe("Work type (drives the workspace phases)."),
  task: z.string().optional().describe("One-line task title."),
  description: z.string().optional().describe("Longer description."),
  labels: z.string().optional().describe("Comma-separated labels."),
  test_path: z.string().optional().describe("Default path for `sandbox open` and the suite."),
  starting_prompt: z
    .string()
    .optional()
    .describe("Prompt the workspace's first session starts from."),
  context_strategy: z
    .enum(STRATEGY_IDS)
    .optional()
    .describe(`Context layer strategy (one of: ${STRATEGY_IDS.join(", ")}).`),
};

function registerAuthoringTools(server: McpServer): void {
  server.registerTool(
    "close-out",
    {
      title: "End a workspace",
      description:
        "The one way to end a workspace. After every PR shipped: close the issue, write closeout.md, " +
        "commit and push every branch, tear the feature down, delete the workspace directory and the " +
        "merged code branches. With `abandon` (a reason) when work is unshipped: record the reason, leave " +
        "the issue, push and keep every branch with commits of its own, then remove. Without `abandon` it refuses while a PR is " +
        "unshipped. Destructive — confirm with the person first. Nothing is deleted if any branch " +
        "cannot be pushed. Refuses without postmortem.md in the workspace: run the werkmeister " +
        "`postmortem` skill first.",
      inputSchema: {
        ...WORKSPACE_ARG,
        abandon: z
          .string()
          .optional()
          .describe(
            "Close out without shipping: why the work is abandoned. Recorded in closeout.md and the PR files.",
          ),
        skip_postmortem: z
          .string()
          .optional()
          .describe(
            "Close out without a post-mortem: why. Recorded in closeout.md. Only when the person says to skip it.",
          ),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const result = await closeOut(resolveWorkspace(args.workspace, headersOf(extra)).name, {
          ...(args.abandon !== undefined ? { abandon: args.abandon } : {}),
          ...(args.skip_postmortem !== undefined ? { skipPostmortem: args.skip_postmortem } : {}),
        });
        // closeOut installs its own collecting reporter for the teardown, and
        // that AsyncLocalStorage scope shadows adapt()'s — re-emit what it
        // captured or the transcript loses the push and down output.
        if (result.output) {
          raw(`${result.output}\n`);
        }
        return { ...result };
      }),
  );

  server.registerTool(
    "init-workspace",
    {
      title: "Reconcile a workspace",
      description:
        "Re-run init-workspace against an existing workspace: reconcile worktrees, regenerate " +
        `CLAUDE.md, .env, ${COMPOSE_FILE}, skills, agents, hooks and .mcp.json from ` +
        ".sandbox/workspace.yml plus any arguments given here.",
      inputSchema: { ...WORKSPACE_ARG, ...WORKSPACE_FIELDS },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { workspace: _id, ...fields } = args;
        const { feature, dir } = resolveFeature(_id, headersOf(extra));
        // No readStdinTask: fd 0 here may be the MCP transport.
        await initWorkspace({ ...fields, feature }, dir);
        return { feature, workspace: dir };
      }),
  );

  server.registerTool(
    "skills",
    {
      title: "Check or sync a workspace's context layer",
      description:
        "`check` reports drift between the workspace's context layer and a fresh rendering; " +
        "`sync` rewrites what drifted. The layer is the workspace's `context_strategy` (jit: " +
        "sb-* skills and gate manifest; icm: standards and stage contracts).",
      inputSchema: {
        ...WORKSPACE_ARG,
        action: z.enum(["check", "sync"]).describe("check reports drift; sync fixes it."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const workspace = resolveWorkspace(args.workspace, headersOf(extra)).dir;
        const strategy = strategyFor(workspace);
        return args.action === "sync"
          ? { ...strategy.sync(workspace) }
          : { drift: strategy.check(workspace) };
      }),
  );

  server.registerTool(
    "standards",
    {
      title: "Validate the standards tree",
      description:
        "Run every structural validator over the configured standards tree. Errors come back as " +
        "data — an empty `errors` with a non-zero `moduleCount` is a clean tree.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => adapt(async () => ({ ...checkStandards() })),
  );

  server.registerTool(
    "hooks",
    {
      title: "Refresh a workspace's context layer",
      description:
        "Refresh the workspace's context layer the way `sandbox up` does: jit re-merges its " +
        "SessionStart and PreToolUse hooks into .claude/settings.json; icm removes any " +
        "sandbox-managed hooks. Never touches hooks it does not own.",
      inputSchema: { ...WORKSPACE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const workspace = resolveWorkspace(args.workspace, headersOf(extra)).dir;
        const strategy = strategyFor(workspace);
        strategy.refresh(workspace);
        return { strategy: strategy.id };
      }),
  );

  server.registerTool(
    "notes",
    {
      title: "Read or graduate a workspace's notes",
      description:
        "`context` renders the session-start standards + notes block. `list` returns the " +
        "workspace's notes and its open `decisions` (icm reads them from stage outputs). " +
        "`graduate` scaffolds one of those decisions into a standards domain — " +
        "domain and kind must be supplied, because the CLI's prompts are not available here.",
      inputSchema: {
        ...WORKSPACE_ARG,
        action: z.enum(["context", "list", "graduate"]),
        includeSuperseded: z.boolean().optional().describe("list: include superseded notes."),
        notePath: z
          .string()
          .optional()
          .describe("graduate: the decision's `path` as `list` returns it."),
        domain: z.string().optional().describe("graduate: standards domain to scaffold into."),
        kind: z
          .enum(["rule", "example", "anti-pattern"])
          .optional()
          .describe("graduate: what kind of standard this becomes."),
        slug: z.string().optional().describe("graduate: filename slug. Defaults from the note."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const workspace = resolveWorkspace(args.workspace, headersOf(extra)).dir;
        if (args.action === "context") {
          return {
            context: strategyFor(workspace).sessionContext(workspace, { source: "mcp" }) ?? "",
          };
        }
        const { decisions } = strategyFor(workspace);
        if (args.action === "list") {
          return {
            notes: listNotes(workspace, args.includeSuperseded ?? false),
            decisions: decisions.open(workspace),
          };
        }
        if (!args.notePath || !args.domain || !args.kind) {
          throw new SandboxError(
            "graduate needs `notePath`, `domain` and `kind` — the CLI resolves these by " +
              "prompting, which a remote caller cannot do.",
            "ARGS",
          );
        }
        // An icm decision's path is `<stage output>#<heading>`, not a file parseNote can read.
        const note =
          decisions.open(workspace).find((d) => d.path === args.notePath) ??
          parseNote(args.notePath);
        if (note === null) {
          throw new SandboxError(`Not a readable note: ${args.notePath}`, "ARGS");
        }
        return {
          scaffolded: graduateNote(workspace, note, {
            domain: args.domain,
            kind: args.kind,
            slug: args.slug ?? null,
            decisions,
          }),
        };
      }),
  );
}

// ---------------------------------------------------------------------------
// Host-side
//
// These three reach beyond the caller's own feature and have host-desktop side
// effects. They are the widest blast radius on this surface: the first thing to
// gate if the token's authority is ever narrowed.
// ---------------------------------------------------------------------------

function registerHostTools(server: McpServer): void {
  server.registerTool(
    "connect",
    {
      title: "Start shared infrastructure",
      description:
        "Bring up the shared infra every feature depends on: generated proxy files, the " +
        "corporate CA, the compose stack (caddy, k8s forwards, and jaeger / redisinsight " +
        "when infra.profiles enables them) and the host web " +
        "servers. Host-wide, not scoped to your feature.",
      inputSchema: {
        k8sOnly: z
          .boolean()
          .optional()
          .describe("Start/restart only the k8s port-forwards container. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        if (args.k8sOnly) {
          return { k8s: await connectK8s() };
        }
        // Health is deliberately not awaited here: infraHealth() waits up to 90
        // seconds for the forwards to converge, which is a `status`
        // call away and should not be inside this one.
        return { infraOk: await infraUp({ signal: extra.signal }) };
      }),
  );

  server.registerTool(
    "open-feature",
    {
      title: "Open a feature-tagged browser window",
      description:
        "Launch a browser window on the HOST, pre-configured with the feature's X-Feature " +
        "routing cookie and tagged so it is unmistakably this feature's window. The window " +
        "outlives this call; it closes when the user closes it.",
      inputSchema: {
        ...WORKSPACE_ARG,
        url: z.string().optional().describe("Explicit URL. Wins over `path`."),
        path: z
          .string()
          .optional()
          .describe(
            "Path on the feature's routed host. Defaults to workspace.yml test_path, else /.",
          ),
        size: z.string().optional().describe("Window size as W,H."),
        position: z.string().optional().describe("Window position as X,Y."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature, dir } = resolveFeature(args.workspace, headersOf(extra));
        const url = args.url ?? featureUrl(args.path ?? readWorkspaceYaml(dir)["test_path"] ?? "/");
        if (url === null) {
          throw new SandboxError(
            "No routed hosts in services.yaml (no service declares `feature_router:`) — " +
              "pass an explicit `url`.",
            "NO_ROUTE",
          );
        }
        const window = await launchFeatureWindow(feature, url, {
          size: args.size,
          position: args.position ?? null,
        });
        if (window === null) {
          throw new SandboxError(
            "Could not launch a browser window — see the transcript for why.",
            "BROWSER",
          );
        }
        // Deliberately not awaited: the window belongs to a human now and this
        // call returns. The catch is not optional — supervise() rejects when
        // the browser dies (browser.ts:540), long after this tool replied, and
        // an unhandled rejection would take the whole server down with it.
        void window.supervise().catch(() => {});
        return { feature, url };
      }),
  );

  server.registerTool(
    "intercept",
    {
      title: "Start or leave a k8s traffic intercept",
      description:
        "Route the slice of live k8s dev traffic carrying `x-feature: <feature>` to this " +
        "feature's local container, or stop doing so. Runs host-side, where the telepresence " +
        "root daemon lives — with exactly the authority a host terminal has.",
      inputSchema: {
        ...WORKSPACE_ARG,
        action: z.enum(["start", "leave"]),
        service: z
          .string()
          .optional()
          .describe("Required to start. On leave, omit to leave every intercept of the feature."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const { feature, dir } = resolveFeature(args.workspace, headersOf(extra));
        const localServices = readServicesFromWorkspace(dir);
        if (args.action === "leave") {
          return {
            left: await leaveIntercept({
              feature,
              service: args.service ?? null,
              localServices,
              signal: extra.signal,
            }),
          };
        }
        if (!args.service) {
          throw new SandboxError("`service` is required to start an intercept.", "ARGS");
        }
        return {
          ...(await startIntercept({
            feature,
            service: args.service,
            localServices,
            signal: extra.signal,
          })),
        };
      }),
  );
}
