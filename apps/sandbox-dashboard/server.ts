/**
 * MCP App server: create a sandbox workspace from inside Claude
 * Desktop, delegating to the `sandbox workspace` CLI.
 *
 * Two linked tools:
 *   - `workspace`        — the App tool (carries `_meta.ui.resourceUri`). When the
 *     host calls it, it renders the bundled HTML form and returns the RJSF
 *     bundle from `getFormSchema` (sandbox-core) for the form to render.
 *   - `create-workspace` — invoked from the form via `app.callServerTool(...)`.
 *     Runs `sandbox workspace <feature> [flags]` (worktrees + branch +
 *     init-workspace) and optionally opens the result in VS Code.
 *
 * The CLI is the single source of truth for both the input prompts and the
 * create logic — this server only renders the form and shells out.
 */
import {
  getUiCapability,
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import {
  approvePr,
  createWorkspace,
  postSlackReviewRequest,
  fetchIssueCard,
  fetchIssueFormData,
  getClaudeTranscript,
  listSessions,
  getClaudeTurnStatus,
  getDockerUi,
  getK8sForwardsHealth,
  getIssueStatuses,
  getKubeContext,
  getOpenPrs,
  getWorkspacePRs,
  getWorkspaceStatuses,
  getWorkspaceUsage,
  launchPrReconcile,
  listWorkspaces,
  openFeatureBrowser,
  openWorkspace,
  refinePrompt,
  removeWorkspace,
  resumeClaudeInTerminal,
  runConnect,
  runWorkspaceAction,
  sendToClaudeSession,
  switchKubeContext,
  WORKSPACE_ACTIONS,
  WorkspaceError,
} from "sandbox-core";
import { getFormBundle, promptViaLocalhostForm } from "./lib/localhost-form.js";

// Works both from source (server.ts via tsx) and compiled (dist/server.js).
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

const RESOURCE_URI = "ui://workspace/mcp-app.html";
const RESOURCE_URI_LIST = "ui://workspace/mcp-list.html";

/**
 * Does the connected client render MCP App `ui://` resources? True only when the
 * client advertised the `io.modelcontextprotocol/ui` capability (with our HTML
 * profile) during initialize — i.e. Claude Desktop. Claude Code CLI / the VS
 * Code extension return `undefined`, so we fall back to the localhost form.
 */
function hostRendersUi(server: McpServer): boolean {
  const uiCap = getUiCapability(server.server.getClientCapabilities());
  return Boolean(uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE));
}

/** Render a {@link createWorkspace} result as the text shown back to the model. */
function formatCreateResult(result: Awaited<ReturnType<typeof createWorkspace>>): string {
  let openLine: string;
  if (result.opened) {
    openLine = "Launched VS Code on the workspace.";
  } else if (result.openNote) {
    openLine = result.openNote;
  } else {
    openLine = result.workspacePath ? `Open with: code "${result.workspacePath}"` : "";
  }
  const head = result.workspacePath
    ? `Created workspace at ${result.workspacePath}`
    : "Workspace command completed.";
  return `${head}\nRan: ${result.command}\n\n${result.output}\n${openLine}`.trim();
}

/** Render the workspace list as a markdown table (non-UI clients). */
function renderWorkspaceTable(result: Awaited<ReturnType<typeof listWorkspaces>>): string {
  if (!result.workspaces.length) return `No workspaces found in ${result.root}.`;
  const rows = result.workspaces.map((w) => {
    const issue = w.issueId && w.issueUrl ? `[${w.issueId}](${w.issueUrl})` : w.issueId || "—";
    return `| [${w.name}](${w.vscodeUri}) | ${issue} |`;
  });
  return (
    `Workspaces in ${result.root} (click a name to open in VS Code):\n\n` +
    `| Workspace | Issue |\n| --- | --- |\n` +
    rows.join("\n") +
    `\n\nFor the interactive dashboard (status, PRs, actions, chat), call the ` +
    `\`open-workspaces-ui\` tool.`
  );
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "sandbox-workspace",
    version: "0.1.0",
  });

  // --- App tool: collect inputs, then create -------------------------------
  // A single tool that adapts to the connecting client (see `hostRendersUi`):
  //   • Hosts that render MCP App UI (Claude Desktop) get the form rendered
  //     INLINE — the tool returns the RJSF bundle and the `ui://` resource (via
  //     `_meta.ui`) draws it; the form then calls `create-workspace` itself.
  //   • Hosts that DON'T (Claude Code CLI, VS Code extension) ignore `_meta.ui`,
  //     so the tool instead opens the SAME form in the user's browser over
  //     localhost, blocks until submit, and creates the workspace in-line.
  // One form definition (`getFormSchema`), one create
  // path (`createWorkspace`), graceful degradation across surfaces.
  registerAppTool(
    server,
    "workspace",
    {
      title: "New Sandbox Workspace",
      description:
        "Create a new sandbox workspace via `sandbox workspace` (git " +
        "worktrees on a <user>/<workspace> branch under $SANDBOX_WORKSPACES_ROOT, " +
        "then init-workspace). Opens a form to collect the inputs — inline if the " +
        "client renders MCP App UI (Claude Desktop), otherwise in the user's " +
        "browser (Claude Code CLI / VS Code). Fields come from the same prompt " +
        "definitions as the terminal wizard. Pass an issue ID or URL as `issue` to pre-fill.",
      inputSchema: {
        issue: z
          .string()
          .optional()
          .describe(
            "Issue ID or URL in this machine's issue tracker (see `sandbox setup`). When set, " +
              "the issue is fetched and used to pre-fill the form (feature, issue_id, task, " +
              "description, starting_prompt).",
          ),
        open: z
          .boolean()
          .optional()
          .describe("Launch VS Code on the new workspace (default true). Browser-form path only."),
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const bundle = await getFormBundle();
        let note = "";
        const issueRef = typeof args?.issue === "string" ? args.issue.trim() : "";
        if (issueRef) {
          const issueData = await fetchIssueFormData(issueRef);
          bundle.formData = { ...bundle.formData, ...issueData };
          const filledKey = typeof issueData.issue_id === "string" ? issueData.issue_id : "";
          note = filledKey
            ? ` Pre-filled from ${filledKey}; review before creating.`
            : ` Couldn't read an issue from “${issueRef}”.`;
        }

        // Inline-UI hosts (Desktop): hand the bundle to the `ui://` form, which
        // calls `create-workspace` on submit.
        if (hostRendersUi(server)) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Opening the workspace form. Fill it in to create a new sandbox " +
                  "workspace (worktrees + branch + init-workspace)." +
                  note,
              },
            ],
            structuredContent: bundle as unknown as Record<string, unknown>,
          };
        }

        // No inline UI (CLI / VS Code): collect via the localhost browser form,
        // then create the workspace here.
        const filled = await promptViaLocalhostForm(bundle);
        if (filled.status !== "submitted") {
          const text =
            filled.status === "cancelled"
              ? "Workspace creation cancelled — nothing was created."
              : "The workspace form timed out — nothing was created. Re-run to try again.";
          return { content: [{ type: "text", text }] };
        }
        // The form's "Open in VS Code" checkbox wins over the tool arg default.
        const result = await createWorkspace(filled.formData ?? {}, {
          open: filled.open ?? args?.open,
        });
        return { content: [{ type: "text", text: formatCreateResult(result) }], structuredContent: result as unknown as Record<string, unknown> };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Worker tool: called by the form to actually create the workspace -----
  // A plain tool (no UI of its own); the form invokes it via app.callServerTool.
  server.registerTool(
    "create-workspace",
    {
      title: "Create Workspace",
      description:
        "Run `sandbox workspace <feature> [flags]` to create the workspace " +
        "(worktrees + branch + init-workspace). Called by the New Sandbox " +
        "Workspace form; can also be invoked directly.",
      inputSchema: {
        formData: z
          .record(z.string(), z.unknown())
          .describe(
            "Submitted form fields (feature, services[], issue_id, test_path, task, …). " +
              "Maps 1:1 onto `sandbox workspace` flags; `feature` is required.",
          ),
        open: z.boolean().optional().describe("Launch VS Code on the new workspace (default true)."),
      },
      outputSchema: z.object({
        command: z.string(),
        output: z.string(),
        workspacePath: z.string().nullable(),
        opened: z.boolean(),
        openNote: z.string().optional(),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await createWorkspace(args.formData ?? {}, { open: args.open });
        return {
          content: [{ type: "text", text: formatCreateResult(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Worker tool: hand the RJSF form bundle to the browser dashboard -------
  // Data-only sibling of the `workspace` tool: returns the exact same bundle
  // (`getFormBundle`) as structuredContent, with no UI
  // of its own. The browser dashboard's "New workspace" tab fetches this, then
  // renders the form and calls `create-workspace` on submit — so create + list
  // live on one page without the localhost-form's separate throwaway server.
  server.registerTool(
    "workspace-form-schema",
    {
      title: "Workspace Form Schema",
      description:
        "Return the New Sandbox Workspace form definition (RJSF schema/uiSchema/formData/title), " +
        "built from the terminal wizard's prompt definitions. Data-only; used by the browser dashboard's " +
        "create-workspace tab.",
      inputSchema: {},
      outputSchema: z.object({
        schema: z.record(z.string(), z.unknown()),
        uiSchema: z.record(z.string(), z.unknown()),
        formData: z.record(z.string(), z.unknown()),
        title: z.string(),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const bundle = await getFormBundle();
        return {
          content: [{ type: "text", text: `Loaded the New Workspace form (${bundle.title}).` }],
          structuredContent: bundle as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Worker tool: map an issue to New-workspace form fields ---------------
  // The browser dashboard's create form calls this from its "Fetch from
  // <tracker>" button to populate fields live. Reuses the exact
  // fetchIssueFormData the `workspace` tool uses for open-time `issue` prefill,
  // so button and arg agree. Best-effort: returns { issue_id } alone when the
  // lookup fails.
  server.registerTool(
    "issue-form-data",
    {
      title: "Issue → Form Fields",
      description:
        "Distil an issue from this machine's issue tracker into New Sandbox Workspace form fields " +
        "(issue_id, feature, task, description, starting_prompt, suggested services) from an issue " +
        "ID or URL. Best-effort; returns just { issue_id } if the lookup fails. Called by the " +
        "form's “Fetch from <tracker>” button.",
      inputSchema: { ref: z.string().describe("An issue ID or URL, or any string containing one.") },
      outputSchema: z.object({ formData: z.record(z.string(), z.unknown()) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const formData = await fetchIssueFormData(args.ref);
        const key = typeof formData.issue_id === "string" ? formData.issue_id : "";
        const text = key ? `Loaded form fields from ${key}.` : `No issue found in “${args.ref}”.`;
        return { content: [{ type: "text", text }], structuredContent: { formData } };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Worker tool: refine the starting-prompt draft via the `claude` CLI ----
  // Called by the form's "Refine this prompt" button. The MCP host here doesn't
  // implement `sampling/createMessage`, so the completion runs locally through
  // the `claude` CLI (same machine + account as Claude Desktop).
  server.registerTool(
    "refine-prompt",
    {
      title: "Refine Prompt",
      description:
        "Rewrite a starting-prompt draft via the local `claude` CLI. Called by the " +
        "New Sandbox Workspace form's “Refine this prompt” button; returns the rewrite.",
      inputSchema: {
        text: z.string().describe("The current prompt text to refine."),
        instruction: z
          .string()
          .optional()
          .describe("How to rewrite it — the field's ui:options.refineInstruction."),
        formData: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Current state of the workspace form (all populated inputs) — embedded as " +
              "background context, alongside the service registry, to ground the rewrite.",
          ),
      },
      outputSchema: z.object({ refined: z.string() }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const refined = await refinePrompt(args.text ?? "", args.instruction ?? "", args.formData);
        return {
          content: [{ type: "text", text: refined }],
          structuredContent: { refined },
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- App tool: list workspaces (inline table UI, or markdown fallback) -----
  // Like `workspace`, this adapts to the client (see `hostRendersUi`):
  //   • Desktop renders the bundled table UI (mcp-list.html) inline via `_meta.ui`;
  //     rows open in VS Code (`open-workspace`) or link to their issue.
  //   • Claude Code CLI / VS Code get a markdown table instead (their link
  //     renderers ignore `vscode://`, so they should call `open-workspace`).
  // Both paths return the same structuredContent, so the model always sees the list.
  registerAppTool(
    server,
    "list-workspaces",
    {
      title: "List Sandbox Workspaces",
      description:
        "List the workspaces under $SANDBOX_WORKSPACES_ROOT (workspace name + issue). " +
        "Renders an interactive table inline where the client supports MCP App UI (Claude " +
        "Desktop), otherwise a markdown table. To open one in VS Code, call `open-workspace` " +
        "with the name.",
      inputSchema: {},
      outputSchema: z.object({
        root: z.string(),
        workspaces: z.array(
          z.object({
            name: z.string(),
            path: z.string(),
            vscodeUri: z.string(),
            issueId: z.string().nullable(),
            issueUrl: z.string().nullable(),
            labels: z.array(z.string()),
          }),
        ),
      }),
      _meta: { ui: { resourceUri: RESOURCE_URI_LIST } },
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await listWorkspaces();
        // Inline-UI hosts (Desktop): the `ui://` table reads structuredContent;
        // keep the text terse. Others get the full markdown table.
        const text = hostRendersUi(server)
          ? `${result.workspaces.length} workspace(s) in ${result.root}.`
          : renderWorkspaceTable(result);
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: open the workspaces dashboard in a browser ---------------------
  // Browser fallback for the inline table UI: hosts that can't render `ui://`
  // (Claude Code CLI, VS Code) call this to get the full interactive dashboard
  // in an ordinary browser tab. See lib/browser-ui.ts.
  server.registerTool(
    "open-workspaces-ui",
    {
      title: "Open Workspaces Dashboard in Browser",
      description:
        "Open the interactive Sandbox Workspaces dashboard in the user's default browser — the " +
        "same UI Claude Desktop renders inline, as a fallback for hosts that don't render MCP App " +
        "UI. Starts a localhost server (reused across calls) and returns its URL.",
      inputSchema: {},
      outputSchema: z.object({ url: z.string() }),
    },
    async (): Promise<CallToolResult> => {
      try {
        // Dynamic import: browser-ui.ts imports createServer from here, so a
        // static import would form a cycle at module load.
        const { launchBrowserUi } = await import("./lib/browser-ui.js");
        const { url } = await launchBrowserUi({ open: true });
        return {
          content: [{ type: "text", text: `Opened the workspaces dashboard at ${url}` }],
          structuredContent: { url },
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: open a workspace in VS Code ------------------------------------
  server.registerTool(
    "open-workspace",
    {
      title: "Open Workspace in VS Code",
      description:
        "Launch VS Code on a workspace directory under $SANDBOX_WORKSPACES_ROOT. Pass the " +
        "workspace `name` as returned by `list-workspaces`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
      },
      outputSchema: z.object({ path: z.string() }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const { path: opened } = await openWorkspace(args.name);
        return {
          content: [{ type: "text", text: `Opened ${opened} in VS Code.` }],
          structuredContent: { path: opened },
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: open a feature-tagged Chrome window for a workspace ------------
  server.registerTool(
    "open-feature",
    {
      title: "Open Feature in Chrome",
      description:
        "Launch a feature-tagged incognito Chrome window for a workspace via `sandbox open` " +
        "(sets the X-Feature routing cookie + tags the window). Routing only resolves if the " +
        "feature is `up`; otherwise traffic falls through to k8s. Pass the workspace `name`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
      },
      outputSchema: z.object({ path: z.string() }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const { path: target } = await openFeatureBrowser(args.name);
        return {
          content: [{ type: "text", text: `Launched a feature-tagged Chrome window for ${args.name}.` }],
          structuredContent: { path: target },
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: run a container-lifecycle action on a workspace ----------------
  // Called by the workspaces table's up/stop/restart/down buttons; can also be
  // invoked directly. Runs `sandbox <action>` in the workspace dir so FEATURE
  // and the slot resolve from that workspace's .env.
  server.registerTool(
    "workspace-action",
    {
      title: "Workspace Container Action",
      description:
        "Run a container-lifecycle command on a workspace's stack: `up` (start), `stop` " +
        "(stop containers, keep the slot), `restart`, or `down` (tear down + release slot). " +
        "Pass the workspace `name` as returned by `list-workspaces`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
        action: z.enum(WORKSPACE_ACTIONS).describe("up | stop | restart | down"),
      },
      outputSchema: z.object({ command: z.string(), output: z.string(), path: z.string() }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await runWorkspaceAction(args.name, args.action);
        return {
          content: [{ type: "text", text: `${result.command}\n\n${result.output}`.trim() }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: pull-request status per workspace repo -------------------------
  // Repo worktrees + each one's PR (via `gh`); the table fills the PRs column
  // asynchronously so the network calls don't block the initial render.
  server.registerTool(
    "workspace-prs",
    {
      title: "Workspace Pull Requests",
      description:
        "For every workspace, list its repo worktrees and the open/merged/closed PR for each " +
        "one's branch (via the `gh` CLI). Best-effort — a repo with no PR (or when `gh` is " +
        "unavailable) reports a null PR.",
      inputSchema: {},
      outputSchema: z.object({
        workspaces: z.array(
          z.object({
            name: z.string(),
            repos: z.array(
              z.object({
                repo: z.string(),
                branch: z.string().nullable(),
                url: z.string().nullable(),
                state: z.enum(["OPEN", "MERGED", "CLOSED"]).nullable(),
                title: z.string().nullable(),
                labels: z.array(z.string()),
              }),
            ),
          }),
        ),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const workspaces = await getWorkspacePRs();
        const text =
          workspaces
            .map((w) => {
              const repos = w.repos
                .map((r) => `${r.repo}${r.state ? ` [${r.state}]` : ""}`)
                .join(", ");
              return `${w.name}: ${repos || "(no repos)"}`;
            })
            .join("\n") || "No workspaces.";
        return {
          content: [{ type: "text", text }],
          structuredContent: { workspaces } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: current issue status for a batch of issue refs ------------------
  // One tracker lookup for all refs; the table fills the issue status badges
  // asynchronously (same fill-in pattern as workspace-prs).
  server.registerTool(
    "issue-statuses",
    {
      title: "Issue Statuses",
      description:
        "Fetch the current status name for a batch of issue IDs in this machine's issue tracker " +
        "in one lookup. Best-effort: issues that can't be fetched are omitted from the result.",
      inputSchema: {
        refs: z.array(z.string()).describe("Issue IDs in the configured tracker."),
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the cache and re-fetch every issue from the tracker."),
      },
      outputSchema: z.object({ statuses: z.record(z.string(), z.string()) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const statuses = await getIssueStatuses(args.refs ?? [], { refresh: args.refresh });
        const text =
          Object.entries(statuses)
            .map(([k, s]) => `${k}: ${s}`)
            .join("\n") || "No statuses found.";
        return {
          content: [{ type: "text", text }],
          structuredContent: { statuses } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // An `Issue` (sandbox-core/issue_tracker): the `issue` card and pr-reconcile's issue.
  const issueSchema = z.object({
    ref: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    assignee: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    comments: z.array(z.object({ author: z.string(), created: z.string().optional(), body: z.string() })).optional(),
  });

  // --- Tool: open PRs across the org (dashboard "Open Pull Requests" tab) -----
  const openPrSchema = z.object({
    url: z.string(),
    repo: z.string(),
    number: z.number(),
    title: z.string(),
    author: z.string(),
    body: z.string(),
    labels: z.array(z.string()),
    reviewStatus: z.enum(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING"]),
    failingChecks: z.number(),
    outOfDate: z.boolean(),
    hasApprovalLabel: z.boolean(),
    issueId: z.string().nullable(),
    issueUrl: z.string().nullable(),
    isDraft: z.boolean(),
  });
  server.registerTool(
    "open-prs",
    {
      title: "Open Pull Requests",
      description:
        "List open PRs across the sandbox org (younger than 30 days): my own PRs and other " +
        "members' ready-for-human-approval PRs, each with review/check/label state and its issue " +
        "ID. Best-effort — a PR whose details can't be read degrades to a stub card.",
      inputSchema: {},
      outputSchema: z.object({
        me: z.string(),
        mine: z.array(openPrSchema),
        others: z.array(openPrSchema),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getOpenPrs();
        const text = `Open PRs — mine: ${result.mine.length}, ready-for-approval: ${result.others.length}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: approve a PR (gh pr review --approve; no label change) -----------
  server.registerTool(
    "pr-approve",
    {
      title: "Approve Pull Request",
      description: "Approve a pull request via `gh pr review <url> --approve`. Does not change labels.",
      inputSchema: { url: z.string().describe("The pull request URL.") },
      outputSchema: z.object({ ok: z.literal(true) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await approvePr(args.url);
        return {
          content: [{ type: "text", text: `Approved ${args.url}.` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: ask for review on a PR (message Slack channel) -------------------
  server.registerTool(
    "ask-pr-review",
    {
      title: "Ask for PR Review",
      description:
        "Message the configured Slack channel to request a review of this pull request. " +
        "The message includes the PR URL, title, and author.",
      inputSchema: {
        url: z.string().describe("The pull request URL."),
        title: z.string().optional().describe("The PR title, for a readable message."),
        author: z.string().optional().describe("The PR author's login."),
      },
      outputSchema: z.object({ ok: z.literal(true) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const who = args.author ? ` (by ${args.author})` : "";
        const text = `Review requested${who}: ${args.title ?? ""} ${args.url}`.trim();
        const channel = await postSlackReviewRequest(text);
        return {
          content: [{ type: "text", text: `Review request sent to Slack (${channel}) for ${args.url}.` }],
          structuredContent: { ok: true },
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: fetch a compact issue card (best-effort) -------------------------
  server.registerTool(
    "issue",
    {
      title: "Issue Card",
      description:
        "Fetch a compact issue card (ref, title, status, type, assignee, description, url, comments) " +
        "from this machine's issue tracker for an issue ID or any string containing one. " +
        "Best-effort: returns `{ ref }` alone if the lookup fails.",
      inputSchema: { ref: z.string().describe("An issue ID or URL, or any string containing one.") },
      outputSchema: issueSchema,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await fetchIssueCard(args.ref);
        const text = result.title ? `${result.ref}: ${result.title}` : result.ref || "No issue.";
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: launch a background PR-reconcile Claude session -----------------
  server.registerTool(
    "pr-reconcile",
    {
      title: "Reconcile PR with Issue",
      description:
        "Gather a PR's issue, description, and diff, then launch a headless, tool-restricted " +
        "`claude -p` session (context handed off at spawn) in a background Terminal window to " +
        "reconcile the two. Returns " +
        "the `sessionKey` the dashboard chat panel streams from (a `reconcile:<repo>-<number>` key).",
      inputSchema: {
        url: z.string().describe("The pull request URL to reconcile."),
        issueRef: z.string().optional().describe("Issue ID hint; inferred from the PR when omitted."),
      },
      outputSchema: z.object({
        sessionKey: z.string(),
        slug: z.string(),
        issue: issueSchema,
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await launchPrReconcile(args.url, args.issueRef);
        return {
          content: [{ type: "text", text: `Launched reconcile session ${result.sessionKey} for ${args.url}.` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: destroy a workspace (down + delete directory) ------------------
  server.registerTool(
    "remove-workspace",
    {
      title: "Hand Off & Delete Workspace",
      description:
        "Hand a workspace off, then tear it down: commit + push every branch (the sandbox-workspace " +
        "root branch AND each repo) so the work survives on the remote, then `sandbox down` (stop " +
        "containers + release the slot), remove the workspace directory, and prune the git worktree " +
        "registrations. Aborts without deleting if any push fails (no work lost). Pass the workspace " +
        "`name` from `list-workspaces`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
      },
      outputSchema: z.object({ command: z.string(), output: z.string(), path: z.string() }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await removeWorkspace(args.name);
        return {
          content: [{ type: "text", text: `${result.command}\n\n${result.output}`.trim() }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        // Surface the real cause to the MCP stderr log — the client only sees
        // `message`, so without this a remove-workspace failure leaves no trace
        // to diagnose. (ponytail: remove-workspace only; generalize to a shared
        // handler wrapper if other tools need the same visibility.)
        console.error(`[sandbox-workspace] remove-workspace failed: ${(e as Error).stack ?? message}`);
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: live container status for all workspaces -----------------------
  // One `docker ps` sweep; used by the workspaces table to show up/stopped/down.
  server.registerTool(
    "workspace-status",
    {
      title: "Workspace Container Status",
      description:
        "Report live container status for every workspace (up / partial / stopped / down), " +
        "from a single `docker ps` sweep matched to each workspace's Compose project.",
      inputSchema: {},
      outputSchema: z.object({
        infra: z.object({
          state: z.enum(["up", "partial", "down", "unknown"]),
          running: z.number(),
          total: z.number(),
          services: z.array(
            z.object({
              name: z.string(),
              state: z.enum(["healthy", "starting", "unhealthy", "running", "down"]),
            }),
          ),
        }),
        statuses: z.array(
          z.object({
            name: z.string(),
            project: z.string().nullable(),
            state: z.enum(["up", "partial", "stopped", "down", "unknown"]),
            running: z.number(),
            total: z.number(),
            slot: z.number().nullable(),
            ports: z.string().nullable(),
            services: z.array(
              z.object({
                name: z.string(),
                state: z.enum(["healthy", "starting", "unhealthy", "running", "down"]),
              }),
            ),
            claude: z.object({
              state: z.enum(["running", "done", "failed", "idle"]),
              waiting: z.boolean(),
            }),
          }),
        ),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const { statuses, infra } = await getWorkspaceStatuses();
        const claudeNote = (c: { state: string; waiting: boolean }): string => {
          if (c.state === "running") return " · claude: working";
          if (c.waiting) return " · claude: waiting for input";
          return "";
        };
        const wsText = statuses
          .map((s) => {
            const counts = s.total ? ` (${s.running}/${s.total})` : "";
            return `${s.name}: ${s.state}${counts}${claudeNote(s.claude)}`;
          })
          .join("\n");
        const text = `infra: ${infra.state}${infra.total ? ` (${infra.running}/${infra.total})` : ""}\n${wsText || "No workspaces."}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { statuses, infra } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: per-workspace token/model usage --------------------------------
  server.registerTool(
    "workspace-usage",
    {
      title: "Workspace Token Usage",
      description:
        "Sum a workspace's Claude Code token usage by model and session, with a " +
        "rough USD estimate (rates from ~/.sandbox/model-pricing.yaml). On-demand.",
      inputSchema: { name: z.string().describe("Workspace name") },
      outputSchema: {
        name: z.string(),
        totals: z.object({
          input: z.number(), output: z.number(),
          cacheCreation: z.number(), cacheRead: z.number(),
        }),
        estUsd: z.number().nullable(),
        byModel: z.array(z.object({
          model: z.string(),
          totals: z.object({
            input: z.number(), output: z.number(),
            cacheCreation: z.number(), cacheRead: z.number(),
          }),
          estUsd: z.number().nullable(),
        })),
        sessions: z.array(z.object({
          sessionId: z.string(), title: z.string(), updatedAt: z.string(),
          totals: z.object({
            input: z.number(), output: z.number(),
            cacheCreation: z.number(), cacheRead: z.number(),
          }),
          estUsd: z.number().nullable(),
        })),
      },
    },
    async ({ name }): Promise<CallToolResult> => {
      try {
        const usage = await getWorkspaceUsage(name);
        const tot = usage.totals.input + usage.totals.output + usage.totals.cacheCreation + usage.totals.cacheRead;
        const dollars = usage.estUsd == null ? "" : ` · ~$${usage.estUsd.toFixed(2)}`;
        const models = usage.byModel.map((m) => m.model).join(", ") || "none";
        const text = `${name}: ${tot.toLocaleString()} tokens${dollars} across ${usage.sessions.length} session(s) [${models}]`;
        return {
          content: [{ type: "text", text }],
          structuredContent: usage as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: start shared infrastructure ------------------------------------
  server.registerTool(
    "sandbox-connect",
    {
      title: "Connect Shared Infrastructure",
      description:
        "Run `sandbox connect` to start shared infrastructure (local services, k8s " +
        "port-forwards). Returns once infra is up.",
      inputSchema: {},
      outputSchema: z.object({ command: z.string(), output: z.string() }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await runConnect();
        return {
          content: [{ type: "text", text: `${result.command}\n\n${result.output}`.trim() }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: docker container-UI link (OrbStack only) -----------------------
  server.registerTool(
    "docker-ui",
    {
      title: "Docker Container UI",
      description:
        "Report the Docker provider and its browser dashboard URL, if any (OrbStack → " +
        "https://orb.local; Docker Desktop has no browser UI, so url is null).",
      inputSchema: {},
      outputSchema: z.object({ provider: z.string(), url: z.string().nullable() }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getDockerUi();
        return {
          content: [{ type: "text", text: `Docker: ${result.provider}${result.url ? ` — ${result.url}` : " (no browser UI)"}` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: default k8s forwards health -------------------------------------
  // Direct health probes against each published forward port (HTTP health
  // endpoint, or TCP connect for endpoint-less forwards like mongodb).
  server.registerTool(
    "k8s-forwards-status",
    {
      title: "k8s Forwards Health",
      description:
        "Check every default k8s port-forward (from ~/.sandbox/services.yaml): HTTP GET " +
        "on each forward's health endpoint (2xx/3xx = healthy), or a TCP connect when it has " +
        "none. Returns per-forward health plus healthy/total counts.",
      inputSchema: {},
      outputSchema: z.object({
        forwards: z.array(
          z.object({
            name: z.string(),
            port: z.number(),
            healthy: z.boolean(),
            detail: z.string().nullable(),
          }),
        ),
        healthy: z.number(),
        total: z.number(),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getK8sForwardsHealth();
        const bad = result.forwards.filter((f) => !f.healthy).map((f) => `${f.name} (${f.detail})`);
        const text =
          `${result.healthy}/${result.total} k8s forwards healthy` +
          (bad.length ? ` — unhealthy: ${bad.join(", ")}` : ".");
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: current kube context -------------------------------------------
  server.registerTool(
    "kube-context",
    {
      title: "Current Kube Context",
      description: "Report the active kubectl context and its environment (dev / stage / prod).",
      inputSchema: {},
      outputSchema: z.object({
        context: z.string().nullable(),
        env: z.enum(["dev", "stage", "prod", "other"]),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getKubeContext();
        return {
          content: [
            { type: "text", text: `Kube context: ${result.context ?? "(none)"} [${result.env}]` },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: switch kube context (defaults to dev) --------------------------
  server.registerTool(
    "kube-switch",
    {
      title: "Switch Kube Context",
      description:
        "Switch the active kubectl context to the dev (default), stage, or prod cluster, " +
        "matched by name pattern. The workspaces table's badge calls this to switch back to dev.",
      inputSchema: {
        env: z
          .enum(["dev", "stage", "prod"])
          .default("dev")
          .describe("Target environment (default dev)."),
      },
      outputSchema: z.object({
        context: z.string(),
        env: z.enum(["dev", "stage", "prod", "other"]),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await switchKubeContext(args.env ?? "dev");
        return {
          content: [{ type: "text", text: `Switched kube context to ${result.context} [${result.env}]` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: newest Claude Code transcript for a workspace ------------------
  // Reads ~/.claude/projects/<encoded-ws-path>/*.jsonl; used by the workspaces
  // table's per-workspace chat panel to show recent history.
  server.registerTool(
    "claude-transcript",
    {
      title: "Claude Code Session Transcript",
      description:
        "Return the newest Claude Code session for a workspace: session ID plus the last N " +
        "user/assistant messages, with tool calls included as compact `tool` activity rows. " +
        "sessionId is null when the workspace has no sessions yet. Pass the workspace `name` " +
        "from `list-workspaces`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max messages to return (default 20)."),
        sessionId: z.string().optional().describe("Read this specific session instead of the newest (from `sessions[]`); stale/unknown ids fall back to newest."),
      },
      outputSchema: z.object({
        sessionId: z.string().nullable(),
        workspacePath: z.string(),
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "tool"]),
            text: z.string(),
            timestamp: z.string().nullable(),
          }),
        ),
        sessionCount: z.number(),
        updatedAt: z.string().nullable(),
        sessions: z.array(
          z.object({
            sessionId: z.string(),
            title: z.string(),
            updatedAt: z.string(),
            isNewest: z.boolean(),
          }),
        ).describe("All sessions for this workspace, newest first — drives the chat panel's session picker."),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const [result, sessions] = await Promise.all([
          getClaudeTranscript(args.name, args.limit ?? 20, args.sessionId),
          listSessions(args.name),
        ]);
        const text = result.sessionId
          ? `Session ${result.sessionId} (${result.messages.length} recent messages, ${result.sessionCount} session(s) total).`
          : `No Claude Code sessions found for ${args.name}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { ...result, sessions } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: send one message to a workspace's Claude Code session -----------
  // Headless `claude -p --resume <id>` in the workspace dir — continues the same
  // session on disk. Quick follow-ups only; long agentic turns should use
  // `claude-resume` (real terminal) instead.
  server.registerTool(
    "claude-send",
    {
      title: "Send to Claude Code Session",
      description:
        "Send one message to a workspace's newest Claude Code session (headless " +
        "`claude -p --resume`), continuing the same session on disk (starts a new session " +
        "if none exists). Fire-and-forget: returns as soon as the turn is started — poll " +
        "`claude-transcript` to watch the reply appear. For a fully interactive session " +
        "use `claude-resume`.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
        message: z.string().describe("The message to send."),
        sessionId: z.string().optional().describe("Resume this specific session instead of the newest; `--resume` bumps it back to newest afterwards."),
      },
      outputSchema: z.object({
        sessionId: z.string().nullable(),
        started: z.boolean(),
        startedNew: z.boolean(),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await sendToClaudeSession(args.name, args.message, args.sessionId);
        const text = result.startedNew
          ? "Started a new session; poll claude-transcript for the reply."
          : `Turn started on session ${result.sessionId}; poll claude-transcript for the reply.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: state of the most recent claude-send turn -----------------------
  // Lets the chat panel show the typing indicator exactly while the turn runs
  // and report real failures, instead of guessing from transcript quiescence.
  server.registerTool(
    "claude-turn-status",
    {
      title: "Claude Turn Status",
      description:
        "Report the state of the most recent `claude-send` turn for a workspace: running, " +
        "done, failed (with error detail), or idle when no turn was started by this server " +
        "process (fall back to polling `claude-transcript`).",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
      },
      outputSchema: z.object({
        state: z.enum(["idle", "running", "done", "failed"]),
        startedAt: z.string().nullable(),
        exitCode: z.number().nullable(),
        error: z.string().nullable(),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await getClaudeTurnStatus(args.name);
        return {
          content: [{ type: "text", text: `Turn state for ${args.name}: ${result.state}${result.error ? ` (${result.error})` : ""}` }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- Tool: resume a workspace's Claude session in Terminal -----------------
  server.registerTool(
    "claude-resume",
    {
      title: "Resume Claude Session in Terminal",
      description:
        "Open a macOS Terminal window in the workspace directory resuming its newest Claude " +
        "Code session (`claude --resume <id>`), fully interactive. Starts a fresh session " +
        "when the workspace has none.",
      inputSchema: {
        name: z.string().describe("Workspace name (an immediate subdir of $SANDBOX_WORKSPACES_ROOT)."),
        sessionId: z.string().optional().describe("Resume this specific session instead of the newest."),
      },
      outputSchema: z.object({
        path: z.string(),
        sessionId: z.string().nullable(),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await resumeClaudeInTerminal(args.name, args.sessionId);
        const text = result.sessionId
          ? `Opened Terminal resuming session ${result.sessionId} in ${result.path}.`
          : `Opened Terminal with a new Claude session in ${result.path}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const message =
          e instanceof WorkspaceError ? e.message : `Unexpected error: ${(e as Error).message}`;
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    },
  );

  // --- UI resource: the bundled single-file HTML form -----------------------
  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  // --- UI resource: the bundled single-file workspaces table ----------------
  registerAppResource(
    server,
    RESOURCE_URI_LIST,
    RESOURCE_URI_LIST,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-list.html"), "utf-8");
      return {
        contents: [{ uri: RESOURCE_URI_LIST, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );

  return server;
}
