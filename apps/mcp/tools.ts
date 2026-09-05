/**
 * The twenty-two tool registrations.
 *
 * Every one is a thin adapter: validate with zod, call the core function inside
 * a collecting reporter, return the transcript as `content` and the typed
 * result as `structuredContent`. Nothing here decides anything a verb should
 * decide — if a registration grows a branch about *what the verb does*, that
 * logic belongs in `sandbox-core` (predecessor spec §4).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { launchFeatureWindow, readWorkspaceYaml } from "sandbox-core/browser";
import { composeLogs } from "sandbox-core/compose";
import { sandboxRoot } from "sandbox-core/config";
import { detectReport } from "sandbox-core/detect";
import { SandboxError } from "sandbox-core/errors";
import { featureUrl } from "sandbox-core/feature_routing";
import { connectK8s, up as infraUp } from "sandbox-core/infra";
import {
  down,
  readServicesFromWorkspace,
  removeService,
  reloadProxy,
  restart,
  stop,
  up,
} from "sandbox-core/lifecycle";
import { collectingReporter, raw, withReporter } from "sandbox-core/reporter";
import { featureServices } from "sandbox-core/slots";
import { interceptsSnapshot, statusSnapshot } from "sandbox-core/status";
import { leaveIntercept, startIntercept } from "sandbox-core/telepresence";
import { runFeatureTests } from "sandbox-core/test_run";

import { resolveFeature, resolveWorkspaceDir } from "./lib/feature.js";

import { writeWorkspaceHooks } from "sandbox-core/hooks_gen";
import { buildContext, listNotes, parseNote } from "sandbox-core/notes";
import { graduateNote } from "sandbox-core/graduate";
import { createWorkspace, listWorkspaces, removeWorkspace } from "sandbox-core";
import { checkStandards } from "sandbox-core/standards";
import { checkSkills, syncSkills } from "sandbox-core/workspace_skills";
import { initWorkspace } from "sandbox-core/workspace_init";

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
 * The feature argument every feature-scoped tool shares: optional, defaulting
 * to the connection's `X-Sandbox-Feature` header.
 */
const FEATURE_ARG = {
  feature: z
    .string()
    .optional()
    .describe("Feature name. Defaults to the X-Sandbox-Feature header on the connection."),
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
    "sandbox-up",
    {
      title: "Bring a feature up",
      description:
        "Allocate the feature's slot, start its containers, and point the reverse proxy at " +
        "them. Returns the slot, port range, local services and their URLs.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return { ...(await up(feature, resolveWorkspaceDir(feature), { signal: extra.signal })) };
      }),
  );

  server.registerTool(
    "sandbox-down",
    {
      title: "Tear a feature down",
      description:
        "Leave the feature's k8s intercepts, remove its containers, and release its slot. " +
        "Does not reload the reverse proxy — call sandbox-proxy-reload after tearing down.",
      inputSchema: {
        ...FEATURE_ARG,
        removeVolumes: z
          .boolean()
          .optional()
          .describe("Also remove the feature's named volumes. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return {
          ...(await down(feature, {
            removeVolumes: args.removeVolumes ?? false,
            signal: extra.signal,
          })),
        };
      }),
  );

  server.registerTool(
    "sandbox-stop",
    {
      title: "Stop a feature's containers",
      description:
        "Stop the containers, leaving them and the slot in place so sandbox-restart or " +
        "sandbox-up can resume the feature.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await stop(resolveFeature(args.feature, (extra as Extra).requestInfo?.headers))),
      })),
  );

  server.registerTool(
    "sandbox-restart",
    {
      title: "Restart a feature's containers",
      description: "Bounce the feature's containers, reusing its slot.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await restart(resolveFeature(args.feature, (extra as Extra).requestInfo?.headers))),
      })),
  );

  server.registerTool(
    "sandbox-status",
    {
      title: "Sandbox status",
      description:
        "Everything `sandbox status` knows: infrastructure containers, the host web servers, " +
        "k8s forwards, every feature's slot and containers, and telepresence intercepts. " +
        "Host-side, so the k8s forward health reported here is the real one.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await statusSnapshot()),
        telepresence: await interceptsSnapshot(),
      })),
  );

  server.registerTool(
    "sandbox-detect",
    {
      title: "Detect changed services",
      description:
        "Which registered services this feature's workspace has local changes for, and which " +
        "have none.",
      inputSchema: {
        ...FEATURE_ARG,
        workspace: z.string().optional().describe("Override the resolved workspace directory."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        // detectReport calls resolveWorkspace() directly, which has no
        // docker-compose.yml guard and, unconfigured, falls back to a path
        // derived from process.cwd() — meaningless for this server. Route
        // through the same guarded resolution every other tool uses so a bad
        // resolution throws WORKSPACE instead of silently reporting on the
        // wrong directory. An explicit `workspace` argument still wins.
        return {
          ...detectReport(feature, args.workspace ?? resolveWorkspaceDir(feature)),
        };
      }),
  );

  server.registerTool(
    "sandbox-services",
    {
      title: "Where a feature's services answer",
      description:
        "Every registered service and its endpoint for this feature — local container, k8s " +
        "forward, or not configured.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await featureServices(
          resolveFeature(args.feature, (extra as Extra).requestInfo?.headers),
        )),
      })),
  );

  server.registerTool(
    "sandbox-logs",
    {
      title: "Read a feature's container logs",
      description:
        "A bounded read of `docker compose logs` for the feature, optionally one service. This " +
        "is not a subscription: it never follows, and returns the last `tail` lines.",
      inputSchema: {
        ...FEATURE_ARG,
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
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const service = args.service ?? null;
        const tail = args.tail ?? 200;
        // follow: false is what makes this return at all; the signal still
        // covers a client that hangs up mid-read.
        await composeLogs(feature, service, { follow: false, tail, signal: extra.signal });
        return { feature, service, tail };
      }),
  );

  server.registerTool(
    "sandbox-remove",
    {
      title: "Drop a service from a feature",
      description:
        "Remove one service from the feature's local services so it falls back to k8s: " +
        "regenerate the workspace files, restart (or stop) the containers, re-point the proxy.",
      inputSchema: {
        ...FEATURE_ARG,
        service: z.string().describe("The local service to drop."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await removeService(
          resolveFeature(args.feature, (extra as Extra).requestInfo?.headers),
          args.service,
        )),
      })),
  );

  server.registerTool(
    "sandbox-test",
    {
      title: "Run a feature's Playwright suite",
      description:
        "Run the feature's Playwright tests with SANDBOX_FEATURE set, so the suite carries the " +
        "X-Feature routing cookie. A failing suite is a result (non-zero `status`), not an error.",
      inputSchema: {
        ...FEATURE_ARG,
        extraArgs: z
          .array(z.string())
          .optional()
          .describe("Extra arguments appended to `npx playwright test`."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return {
          ...(await runFeatureTests({
            feature,
            workspace: resolveWorkspaceDir(feature),
            root: sandboxRoot(),
            extraArgs: args.extraArgs ?? [],
            signal: extra.signal,
          })),
        };
      }),
  );

  server.registerTool(
    "sandbox-proxy-reload",
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
 * The wizard's fields as tool arguments.
 *
 * `sandbox-workspace` binds to `createWorkspace`, the non-interactive path the
 * dashboard already drives — not to the TTY wizard in `commands/workspace.ts`.
 * Every input the wizard would prompt for is here, so nothing has to block on a
 * terminal that does not exist.
 */
const WORKSPACE_FIELDS = {
  repos: z.string().optional().describe("Comma-separated repos to check out."),
  services: z.string().optional().describe("Comma-separated services to run locally."),
  jira_id: z.string().optional().describe("Jira ticket key or URL."),
  work_type: z.string().optional().describe("Work type (drives the workspace phases)."),
  task: z.string().optional().describe("One-line task title."),
  description: z.string().optional().describe("Longer description."),
  labels: z.string().optional().describe("Comma-separated labels."),
  test_path: z.string().optional().describe("Default path for `sandbox open` and the suite."),
  starting_prompt: z.string().optional().describe("Prompt the workspace's first session starts from."),
};

function registerAuthoringTools(server: McpServer): void {
  server.registerTool(
    "sandbox-workspace",
    {
      title: "Create a sandbox workspace",
      description:
        "Create a workspace: git worktrees on a <user>/<workspace> branch under the workspaces " +
        "root, then init-workspace. Non-interactive — every wizard input is an argument here. " +
        "Never opens VS Code.",
      inputSchema: {
        feature: z.string().describe("Feature name. Required — this creates the feature."),
        ...WORKSPACE_FIELDS,
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => {
        // open: false — a container agent has no desktop, and launching an
        // editor is sandbox-open's job, asked for explicitly.
        const result = await createWorkspace({ ...args }, { open: false });
        // createWorkspace installs its OWN collecting reporter internally, and
        // AsyncLocalStorage nesting means that inner scope shadows the one
        // adapt() installed — so nothing it emits during provisioning reaches
        // our transcript. Re-emit the transcript it captured, or `content`
        // comes back empty for the one tool that does the most work.
        if (result.output) {
          raw(`${result.output}\n`);
        }
        return { ...result };
      }),
  );

  server.registerTool(
    "sandbox-list-workspaces",
    {
      title: "List sandbox workspaces",
      description:
        "Every workspace directory under the workspaces root, with its path, Jira ticket, " +
        "labels and VS Code URI. Not scoped to a feature — this is the whole root, and it " +
        "lists workspaces that were never brought up.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => {
        const result = await listWorkspaces();
        // listWorkspaces is a directory scan and reports nothing through the
        // reporter, so `content` would be empty without this. The names and
        // tickets are the transcript; structuredContent carries the rest.
        raw(
          `${
            result.workspaces.map((w) => `${w.name}${w.jiraId ? `  ${w.jiraId}` : ""}`).join("\n") ||
            "(no workspaces)"
          }\n`,
        );
        return { ...result };
      }),
  );

  server.registerTool(
    "sandbox-remove-workspace",
    {
      title: "Hand off and delete a workspace",
      description:
        "Commit and push every worktree branch, tear the feature down, delete the workspace " +
        "directory and prune the source repos. Destructive, and NOT scoped to your feature — it " +
        "names a workspace. Nothing is deleted if any branch cannot be pushed.",
      inputSchema: {
        name: z
          .string()
          .describe("Workspace directory name, as sandbox-list-workspaces reports it."),
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => {
        const result = await removeWorkspace(args.name);
        // Same shadowing as sandbox-workspace: removeWorkspace installs its own
        // collecting reporter for the teardown, so re-emit what it captured or
        // the transcript loses the push and down output.
        if (result.output) {
          raw(`${result.output}\n`);
        }
        return { ...result };
      }),
  );

  server.registerTool(
    "sandbox-init-workspace",
    {
      title: "Reconcile a workspace",
      description:
        "Re-run init-workspace against an existing workspace: reconcile worktrees, regenerate " +
        "CLAUDE.md, .env, docker-compose.yml, skills, agents, hooks and .mcp.json from " +
        ".sandbox/workspace.yml plus any arguments given here.",
      inputSchema: { ...FEATURE_ARG, ...WORKSPACE_FIELDS },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        // No readStdinTask: fd 0 here may be the MCP transport.
        await initWorkspace({ ...args, feature }, workspace);
        return { feature, workspace };
      }),
  );

  server.registerTool(
    "sandbox-skills",
    {
      title: "Check or sync a workspace's projected skills",
      description:
        "`check` reports authoring problems in this repo's standards and drift in the " +
        "workspace's .claude/skills/. `sync` reprojects the skills and refreshes the gate " +
        "manifest.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["check", "sync"]).describe("check reports drift; sync fixes it."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        return args.action === "sync"
          ? { ...syncSkills(workspace) }
          : { ...checkSkills(workspace) };
      }),
  );

  server.registerTool(
    "sandbox-standards",
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
    "sandbox-hooks",
    {
      title: "Write a workspace's Claude Code hooks",
      description:
        "Merge the SessionStart and PreToolUse gate entries into the workspace's " +
        ".claude/settings.json. Never clobbers hooks it does not own.",
      inputSchema: { ...FEATURE_ARG },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        return { path: writeWorkspaceHooks(resolveWorkspaceDir(feature)) };
      }),
  );

  server.registerTool(
    "sandbox-notes",
    {
      title: "Read or graduate a workspace's notes",
      description:
        "`context` renders the session-start standards + notes block. `list` returns the " +
        "workspace's notes. `graduate` scaffolds a decision note into a standards domain — " +
        "domain and kind must be supplied, because the CLI's prompts are not available here.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["context", "list", "graduate"]),
        includeSuperseded: z.boolean().optional().describe("list: include superseded notes."),
        notePath: z.string().optional().describe("graduate: absolute path of the decision note."),
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
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        if (args.action === "context") {
          return { context: buildContext(workspace, "mcp") };
        }
        if (args.action === "list") {
          return { notes: listNotes(workspace, args.includeSuperseded ?? false) };
        }
        if (!args.notePath || !args.domain || !args.kind) {
          throw new SandboxError(
            "graduate needs `notePath`, `domain` and `kind` — the CLI resolves these by " +
              "prompting, which a remote caller cannot do.",
            "ARGS",
          );
        }
        const note = parseNote(args.notePath);
        if (note === null) {
          throw new SandboxError(`Not a readable note: ${args.notePath}`, "ARGS");
        }
        return {
          scaffolded: graduateNote(workspace, note, {
            domain: args.domain,
            kind: args.kind,
            slug: args.slug ?? null,
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
    "sandbox-connect",
    {
      title: "Start shared infrastructure",
      description:
        "Bring up the shared infra every feature depends on: generated proxy files, the " +
        "corporate CA, the compose stack (caddy, k8s forwards, jaeger) and the host web " +
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
          return { k8s: connectK8s() };
        }
        // Health is deliberately not awaited here: infraHealth() waits up to 90
        // seconds for the forwards to converge, which is a `sandbox-status`
        // call away and should not be inside this one.
        return { infraOk: await infraUp({ signal: extra.signal }) };
      }),
  );

  server.registerTool(
    "sandbox-open",
    {
      title: "Open a feature-tagged browser window",
      description:
        "Launch a browser window on the HOST, pre-configured with the feature's X-Feature " +
        "routing cookie and tagged so it is unmistakably this feature's window. The window " +
        "outlives this call; it closes when the user closes it.",
      inputSchema: {
        ...FEATURE_ARG,
        url: z.string().optional().describe("Explicit URL. Wins over `path`."),
        path: z
          .string()
          .optional()
          .describe("Path on the feature's routed host. Defaults to workspace.yml test_path, else /."),
        size: z.string().optional().describe("Window size as W,H."),
        position: z.string().optional().describe("Window position as X,Y."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const workspace = resolveWorkspaceDir(feature);
        const url =
          args.url ??
          featureUrl(args.path ?? readWorkspaceYaml(workspace)["test_path"] ?? "/");
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
    "sandbox-intercept",
    {
      title: "Start or leave a k8s traffic intercept",
      description:
        "Route the slice of live k8s dev traffic carrying `x-feature: <feature>` to this " +
        "feature's local container, or stop doing so. Runs host-side, where the telepresence " +
        "root daemon lives — with exactly the authority a host terminal has.",
      inputSchema: {
        ...FEATURE_ARG,
        action: z.enum(["start", "leave"]),
        service: z
          .string()
          .optional()
          .describe("Required to start. On leave, omit to leave every intercept of the feature."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = resolveFeature(args.feature, (extra as Extra).requestInfo?.headers);
        const localServices = readServicesFromWorkspace(resolveWorkspaceDir(feature));
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
