/**
 * The tools that came from the dashboard's `workspaces` server (SW-48): issues,
 * PRs, Claude sessions, cluster and Docker probes, and the two MCP App tools
 * whose `ui://` resources Claude Desktop renders inline.
 *
 * Every client gets the same tools. The App tools adapt to the client
 * (`rendersUi`): Desktop gets the bundled HTML, everything else a text or
 * browser fallback. The HTML is this app's build (vite, from werkmeister-ui) and
 * the browser form the dashboard's; both ship with a checkout only — a package
 * install takes the fallback.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  getUiCapability,
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import {
  approvePr,
  type CreateResult,
  checkInTriage,
  createWorkspace,
  fetchIssueCard,
  fetchIssueFormData,
  gatePrs,
  getClaudeTranscript,
  getClaudeTurnStatus,
  getDockerUi,
  getFormSchema,
  getIssueStatuses,
  getK8sForwardsHealth,
  getKubeContext,
  getOpenPrs,
  getWorkspacePRs,
  getWorkspaceStatuses,
  getWorkspaceUsage,
  launchPrReconcile,
  listSessions,
  listWorkspaces,
  openPrs,
  openWorkspace,
  postSlackReviewRequest,
  refinePrompt,
  refreshPrStatus,
  resumeClaudeInTerminal,
  sendToClaudeSession,
  switchKubeContext,
  WorkspaceError,
} from "werkmeister-core";
import { sandboxRoot } from "werkmeister-core/config";
import { SandboxError } from "werkmeister-core/errors";
import { collectingReporter, withReporter } from "werkmeister-core/reporter";
import { interceptsSnapshot, statusSnapshot } from "werkmeister-core/status";
import { DASHBOARD, start as startWebApp } from "werkmeister-core/web_servers";
import { z } from "zod";
import { resolveWorkspace, scopeOfHeaders, workspaceId } from "./lib/feature.js";
import { headersOf, WORKSPACE_ARG } from "./tools.js";

const RESOURCE_URI = "ui://workspace/mcp-app.html";
const RESOURCE_URI_LIST = "ui://workspace/mcp-list.html";

/** UI-only tools: the App's own plumbing, hidden from the model (ui-spec § One MCP server). */
const APP_ONLY = { ui: { visibility: ["app"] } };

/** A file from an app's build, or null where there is none (a package install, an unbuilt checkout). */
function appFile(app: "werkmeister-mcp" | "werkmeister-dashboard", name: string): string | null {
  try {
    // Relative to apps/cli, not this file: the CLI bundles this server into its own dist/.
    const file = path.join(sandboxRoot(), "..", app, "dist", name);
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Does the connected client render this App's `ui://` resource? Only when it
 * advertised the `io.modelcontextprotocol/ui` capability with our HTML profile
 * during initialize — Claude Desktop — and the HTML exists to serve. Claude
 * Code CLI and the VS Code extension advertise nothing and get the fallback.
 */
function rendersUi(server: McpServer, html: string): boolean {
  const uiCap = getUiCapability(server.server.getClientCapabilities());
  return (
    Boolean(uiCap?.mimeTypes?.includes(RESOURCE_MIME_TYPE)) &&
    appFile("werkmeister-mcp", html) !== null
  );
}

function readAppHtml(name: string): string {
  const file = appFile("werkmeister-mcp", name);
  if (file === null) {
    throw new Error(`${name} is not built here — run \`pnpm run build\` in apps/werkmeister-mcp.`);
  }
  return fs.readFileSync(file, "utf-8");
}

function fail(e: unknown): CallToolResult {
  const message =
    e instanceof WorkspaceError || e instanceof SandboxError
      ? e.message
      : `Unexpected error: ${(e as Error).message}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** The session tools also take the PR chat's `reconcile:<repo>-<number>` keys, which name no workspace. */
const SESSION_ARG = {
  workspace: z
    .string()
    .optional()
    .describe(
      "Workspace directory name or feature name, or a `reconcile:<repo>-<number>` key from " +
        "pr-reconcile. Defaults to the X-Werkmeister-Feature header on the connection.",
    ),
};

function sessionKey(explicit: string | undefined, extra: unknown): string {
  const id = workspaceId(explicit, headersOf(extra));
  return id.startsWith("reconcile:") ? id : resolveWorkspace(id, undefined).name;
}

/** Render a {@link createWorkspace} result as the text shown back to the model. */
function formatCreateResult(result: CreateResult): string {
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

/** Open the user's default browser at `url`, detached and best-effort. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore" })
    .on("error", () => {})
    .unref();
}

type FormCliOutcome =
  | { status: "cancelled" | "timeout" }
  | { status: "error"; message: string }
  | {
      status: "submitted";
      create: { ok: true; result: CreateResult } | { ok: false; error: string };
    };

/**
 * The browser form for a client that can't render `ui://`: the dashboard's
 * `form-cli.js` (what `werkmeister workspace new --browser-form` runs) serves the
 * form on localhost, waits for submit or cancel, creates the workspace and
 * prints one JSON outcome.
 */
function runFormCli(
  cli: string,
  issue: string,
  open: boolean | undefined,
): Promise<FormCliOutcome> {
  const args = [cli, ...(issue ? ["--issue", issue] : []), ...(open ? ["--open"] : [])];
  return new Promise((resolve) => {
    // stdout carries the outcome; its progress goes to our stderr, never to a stdio JSON-RPC stdout.
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ status: "error", message: e.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
      } catch {
        resolve({ status: "error", message: `The form exited without an outcome: ${out.trim()}` });
      }
    });
  });
}

export function registerWorkspaceTools(server: McpServer): void {
  // --- App tool: collect inputs, then create -------------------------------
  // Desktop draws the bundled form inline from the RJSF bundle this returns, and
  // the form calls `create-workspace` itself. Other clients get the same form in
  // the browser through form-cli.js, which creates the workspace on submit.
  registerAppTool(
    server,
    "create-workspace-form",
    {
      title: "New Werkmeister Workspace",
      description:
        "Open the New Werkmeister Workspace form and create the workspace from it (git worktrees on a " +
        "<user>/<workspace> branch under $WERKMEISTER_WORKSPACES_ROOT, then init-workspace). With an " +
        "`issue_id` the issue is fetched and stored in `.werkmeister/issue.md` (the create fails if it " +
        "can't be read). The form renders inline where the client supports MCP App UI (Claude " +
        "Desktop), otherwise in the user's browser. Fields come from the same prompt definitions " +
        "as the terminal wizard. Pass an issue ID or URL as `issue` to pre-fill. To create without " +
        "a form, call `create-workspace`.",
      inputSchema: {
        issue: z
          .string()
          .optional()
          .describe(
            "Issue ID or URL in this machine's issue tracker (see `werkmeister machine setup`). When set, " +
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
        const issueRef = typeof args?.issue === "string" ? args.issue.trim() : "";
        if (rendersUi(server, "mcp-app.html")) {
          const bundle = await getFormSchema();
          let note = "";
          if (issueRef) {
            const issueData = await fetchIssueFormData(issueRef);
            bundle.formData = { ...bundle.formData, ...issueData };
            const filledKey = typeof issueData.issue_id === "string" ? issueData.issue_id : "";
            note = filledKey
              ? ` Pre-filled from ${filledKey}; review before creating.`
              : ` Couldn't read an issue from “${issueRef}”.`;
          }
          return {
            content: [
              {
                type: "text",
                text:
                  "Opening the workspace form. Fill it in to create a new " +
                  "workspace (worktrees + branch + init-workspace)." +
                  note,
              },
            ],
            structuredContent: bundle as unknown as Record<string, unknown>,
          };
        }

        const cli = appFile("werkmeister-dashboard", "form-cli.js");
        if (cli === null) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  "The browser form ships with a werkmeister checkout (apps/werkmeister-dashboard), " +
                  "not this install. Call `create-workspace` with the fields as `formData`.",
              },
            ],
          };
        }
        // The form's "Open in VS Code" checkbox wins over this default.
        const outcome = await runFormCli(cli, issueRef, args?.open ?? true);
        switch (outcome.status) {
          case "cancelled":
            return {
              content: [
                { type: "text", text: "Workspace creation cancelled — nothing was created." },
              ],
            };
          case "timeout":
            return {
              content: [
                {
                  type: "text",
                  text: "The workspace form timed out — nothing was created. Re-run to try again.",
                },
              ],
            };
          case "error":
            return { isError: true, content: [{ type: "text", text: outcome.message }] };
        }
        if (!outcome.create.ok) {
          return { isError: true, content: [{ type: "text", text: outcome.create.error }] };
        }
        return {
          content: [{ type: "text", text: formatCreateResult(outcome.create.result) }],
          structuredContent: outcome.create.result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        "Create the workspace through `createWorkspace` in this process " +
        "(worktrees + branch + init-workspace); with an `issue_id` the issue is fetched and " +
        "stored in `.werkmeister/issue.md` (the create fails if it can't be read). Called by the New Werkmeister " +
        "Workspace form; can also be invoked directly.",
      inputSchema: {
        formData: z
          .record(z.string(), z.unknown())
          .describe(
            "Submitted form fields (feature, services[], issue_id, test_path, task, …). " +
              "Holds the form's fields, same keys as the CLI flags; `feature` is required.",
          ),
        open: z
          .boolean()
          .optional()
          .describe("Launch VS Code on the new workspace (default false)."),
      },
      annotations: { readOnlyHint: false },
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
        // false by default: a headless or container caller has no desktop to open it on.
        const result = await createWorkspace(args.formData ?? {}, { open: args.open ?? false });
        return {
          content: [{ type: "text", text: formatCreateResult(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Worker tool: hand the RJSF form bundle to the browser dashboard -------
  // Data-only sibling of `create-workspace-form`: returns the exact same bundle
  // (`getFormSchema`) as structuredContent, with no UI
  // of its own. The browser dashboard's "New workspace" tab fetches this, then
  // renders the form and calls `create-workspace` on submit — so create + list
  // live on one page without the localhost-form's separate throwaway server.
  server.registerTool(
    "workspace-form-schema",
    {
      title: "Workspace Form Schema",
      description:
        "Return the New Werkmeister Workspace form definition (RJSF schema/uiSchema/formData/title), " +
        "built from the terminal wizard's prompt definitions. Data-only; used by the browser dashboard's " +
        "create-workspace tab.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        schema: z.record(z.string(), z.unknown()),
        uiSchema: z.record(z.string(), z.unknown()),
        formData: z.record(z.string(), z.unknown()),
        title: z.string(),
      }),
      _meta: APP_ONLY,
    },
    async (): Promise<CallToolResult> => {
      try {
        const bundle = await getFormSchema();
        return {
          content: [{ type: "text", text: `Loaded the New Workspace form (${bundle.title}).` }],
          structuredContent: bundle as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Worker tool: map an issue to New-workspace form fields ---------------
  // The browser dashboard's create form calls this from its "Fetch from
  // <tracker>" button to populate fields live. Reuses the exact
  // fetchIssueFormData `create-workspace-form` uses for open-time `issue` prefill,
  // so button and arg agree. Best-effort: returns { issue_id } alone when the
  // lookup fails.
  server.registerTool(
    "issue-form-data",
    {
      title: "Issue → Form Fields",
      description:
        "Distil an issue from this machine's issue tracker into New Werkmeister Workspace form fields " +
        "(issue_id, feature, task, description, starting_prompt, suggested services) from an issue " +
        "ID or URL. Best-effort; returns just { issue_id } if the lookup fails. Called by the " +
        "form's “Fetch from <tracker>” button.",
      inputSchema: {
        ref: z.string().describe("An issue ID or URL, or any string containing one."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ formData: z.record(z.string(), z.unknown()) }),
      _meta: APP_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const formData = await fetchIssueFormData(args.ref);
        const key = typeof formData.issue_id === "string" ? formData.issue_id : "";
        const text = key ? `Loaded form fields from ${key}.` : `No issue found in “${args.ref}”.`;
        return { content: [{ type: "text", text }], structuredContent: { formData } };
      } catch (e) {
        return fail(e);
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
        "New Werkmeister Workspace form's “Refine this prompt” button; returns the rewrite.",
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
      annotations: { readOnlyHint: false },
      outputSchema: z.object({ refined: z.string() }),
      _meta: APP_ONLY,
    },
    async (args): Promise<CallToolResult> => {
      try {
        const refined = await refinePrompt(args.text ?? "", args.instruction ?? "", args.formData);
        return {
          content: [{ type: "text", text: refined }],
          structuredContent: { refined },
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- App tool: list workspaces (inline table UI, or markdown fallback) -----
  // Like `create-workspace-form`, this adapts to the client (see `rendersUi`):
  //   • Desktop renders the bundled table UI (mcp-list.html) inline via `_meta.ui`;
  //     rows open in VS Code (`open-workspace`) or link to their issue.
  //   • Claude Code CLI / VS Code get a markdown table instead (their link
  //     renderers ignore `vscode://`, so they should call `open-workspace`).
  // Both paths return the same structuredContent, so the model always sees the list.
  registerAppTool(
    server,
    "list-workspaces",
    {
      title: "List Werkmeister Workspaces",
      description:
        "List the workspaces under $WERKMEISTER_WORKSPACES_ROOT (workspace name + issue). " +
        "Renders an interactive table inline where the client supports MCP App UI (Claude " +
        "Desktop), otherwise a markdown table. To open one in VS Code, call `open-workspace` " +
        "with the name.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
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
            model: z.string().nullable(),
            task: z.string().nullable(),
            workType: z.string().nullable(),
            lifecycle: z.string(),
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
        const text = rendersUi(server, "mcp-list.html")
          ? `${result.workspaces.length} workspace(s) in ${result.root}.`
          : renderWorkspaceTable(result);
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: open the workspaces dashboard in a browser ---------------------
  // Browser fallback for the inline table UI: hosts that can't render `ui://`
  // (Claude Code CLI, VS Code) get the full dashboard in a browser tab. It is
  // the managed server `connect` starts, so the URL is always the same one.
  server.registerTool(
    "open-workspaces-ui",
    {
      title: "Open Workspaces Dashboard in Browser",
      description:
        "Open the interactive Werkmeister Workspaces dashboard in the user's default browser — the " +
        "same UI Claude Desktop renders inline, as a fallback for hosts that don't render MCP App " +
        "UI. Starts the localhost dashboard on port 3001 if it isn't running, and returns its URL.",
      inputSchema: {},
      annotations: { readOnlyHint: false },
      outputSchema: z.object({ url: z.string() }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const reporter = collectingReporter();
        if (!(await withReporter(reporter, () => startWebApp(DASHBOARD, false)))) {
          throw new WorkspaceError(`Could not start the workspaces dashboard:\n${reporter.text()}`);
        }
        const url = `http://127.0.0.1:${DASHBOARD.port}/`;
        openBrowser(url);
        return {
          content: [{ type: "text", text: `Opened the workspaces dashboard at ${url}` }],
          structuredContent: { url },
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: open a workspace in VS Code ------------------------------------
  server.registerTool(
    "open-workspace",
    {
      title: "Open Workspace in VS Code",
      description: "Launch VS Code on a workspace directory under $WERKMEISTER_WORKSPACES_ROOT. ",
      inputSchema: {
        ...WORKSPACE_ARG,
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({ path: z.string() }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const { path: opened } = await openWorkspace(
          resolveWorkspace(args.workspace, headersOf(extra)).name,
        );
        return {
          content: [{ type: "text", text: `Opened ${opened} in VS Code.` }],
          structuredContent: { path: opened },
        };
      } catch (e) {
        return fail(e);
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
      annotations: { readOnlyHint: true },
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
                ci: z.enum(["pass", "running", "fail"]).nullable(),
                failingChecks: z.number(),
                draft: z.boolean().optional(),
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
        return fail(e);
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
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ statuses: z.record(z.string(), z.string()) }),
      _meta: APP_ONLY,
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
        return fail(e);
      }
    },
  );

  // An `Issue` (werkmeister-core/issue_tracker): the `issue` card and pr-reconcile's issue.
  const issueSchema = z.object({
    ref: z.string(),
    title: z.string().optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    assignee: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    comments: z
      .array(z.object({ author: z.string(), created: z.string().optional(), body: z.string() }))
      .optional(),
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
        "List open PRs across the GitHub org (younger than 30 days): my own PRs and other " +
        "members' ready-for-human-approval PRs, each with review/check/label state and its issue " +
        "ID. Best-effort — a PR whose details can't be read degrades to a stub card.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
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
        return fail(e);
      }
    },
  );

  // --- Tool: approve a PR (gh pr review --approve; no label change) -----------
  server.registerTool(
    "pr-approve",
    {
      title: "Approve Pull Request",
      description:
        "Approve a pull request via `gh pr review <url> --approve`. Does not change labels.",
      inputSchema: { url: z.string().describe("The pull request URL.") },
      annotations: { readOnlyHint: false },
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
        return fail(e);
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
      annotations: { readOnlyHint: false },
      outputSchema: z.object({ ok: z.literal(true) }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const who = args.author ? ` (by ${args.author})` : "";
        const text = `Review requested${who}: ${args.title ?? ""} ${args.url}`.trim();
        const channel = await postSlackReviewRequest(text);
        return {
          content: [
            { type: "text", text: `Review request sent to Slack (${channel}) for ${args.url}.` },
          ],
          structuredContent: { ok: true },
        };
      } catch (e) {
        return fail(e);
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
      inputSchema: {
        ref: z.string().describe("An issue ID or URL, or any string containing one."),
      },
      annotations: { readOnlyHint: true },
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
        return fail(e);
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
        issueRef: z
          .string()
          .optional()
          .describe("Issue ID hint; inferred from the PR when omitted."),
      },
      annotations: { readOnlyHint: false },
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
          content: [
            {
              type: "text",
              text: `Launched reconcile session ${result.sessionKey} for ${args.url}.`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tools: the workspace PR lifecycle (docs/workspace-lifecycle.md) -------
  server.registerTool(
    "workspace-pr",
    {
      title: "Workspace PR: gate, open, status",
      description:
        "The only way to open a PR from a workspace — use it instead of `gh pr create`, " +
        "`/create-pr` or `finishing-a-development-branch`. `gate` runs the pre-PR gate; `open` gates " +
        "each PR file at `status: approved`, pushes, opens the PR and records its URL; `status` records " +
        "merged / shipped / closed from GitHub and release tags.",
      inputSchema: {
        ...WORKSPACE_ARG,
        action: z.enum(["gate", "open", "status"]),
        repo: z.string().optional().describe("Only this code worktree's PR file."),
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({ ok: z.boolean(), lines: z.array(z.string()) }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const ws = resolveWorkspace(args.workspace, headersOf(extra)).dir;
        const result =
          args.action === "gate"
            ? await gatePrs(ws, args.repo)
            : args.action === "open"
              ? await openPrs(ws, args.repo)
              : { ok: true, lines: (await refreshPrStatus(ws)).lines };
        return {
          isError: !result.ok,
          content: [{ type: "text", text: result.lines.join("\n") }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: live container status for all workspaces -----------------------
  // One `docker ps` sweep; the dashboard polls it every 5 s. The host snapshot
  // probes every k8s forward in turn, so it waits for `detail`.
  server.registerTool(
    "status",
    {
      title: "Werkmeister status",
      description:
        "Report live container status for every workspace (up / partial / stopped / down) and the " +
        "shared infra, from a single `docker ps` sweep matched to each workspace's Compose project, " +
        "with each workspace's agent state. With `detail: true`, also everything `werkmeister feature status` " +
        "knows (as `host`): infrastructure containers, the host web servers, k8s forward health, " +
        "every feature's slot and containers, and telepresence intercepts.",
      inputSchema: {
        detail: z
          .boolean()
          .optional()
          .describe(
            "Add the host-wide `werkmeister feature status` snapshot. Slower: it probes every k8s forward.",
          ),
      },
      annotations: { readOnlyHint: true },
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
        // Loose: WorkspaceStatus carries more than the fields listed here, and an SDK
        // client that ran tools/list rejects extra keys on a strict object.
        statuses: z.array(
          z.looseObject({
            name: z.string(),
            project: z.string().nullable(),
            state: z.enum(["up", "partial", "stopped", "paused", "down", "unknown"]),
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
              agent: z.enum(["working", "needs-you", "done", "idle"]),
              at: z.string().nullable(),
              question: z.string().nullable(),
            }),
            paused: z.object({ at: z.string(), containers: z.array(z.string()) }).nullable(),
            resumeNudge: z.boolean(),
          }),
        ),
        host: z.record(z.string(), z.unknown()).optional(),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const all = await getWorkspaceStatuses();
        // A per-workspace token sees its own workspace only (SW-184).
        const scope = scopeOfHeaders(headersOf(extra));
        const { infra } = all;
        const statuses = scope ? all.statuses.filter((s) => s.name === scope) : all.statuses;
        const host =
          args.detail && !scope
            ? { ...(await statusSnapshot()), telepresence: await interceptsSnapshot() }
            : undefined;
        const claudeNote = (c: { agent: string }): string =>
          c.agent === "idle" ? "" : ` · claude: ${c.agent === "needs-you" ? "needs you" : c.agent}`;
        const wsText = statuses
          .map((s) => {
            const counts = s.total ? ` (${s.running}/${s.total})` : "";
            // A held session's last state (needs you, working) is not news while paused.
            return `${s.name}: ${s.state}${counts}${s.paused ? "" : claudeNote(s.claude)}`;
          })
          .join("\n");
        const text = `infra: ${infra.state}${infra.total ? ` (${infra.running}/${infra.total})` : ""}\n${wsText || "No workspaces."}`;
        return {
          content: [{ type: "text", text: host ? `${text}\n\n${JSON.stringify(host)}` : text }],
          structuredContent: { statuses, infra, host } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: check-in triage --------------------------------------------------
  // The check-in skill's step 1 in one call. Plain JSON on purpose: no `_meta.ui`,
  // so a sweep from the root session never renders the workspaces table inline.
  server.registerTool(
    "check-in",
    {
      title: "Check-in Triage",
      description:
        "One sweep for the check-in skill: every workspace's labels, container and Claude " +
        "state, proposed stage gates, and whether its transcript changed since the last " +
        "check-in, plus its `lifecycle`, `paused` and `prs` (repo, url, status, `release`). " +
        "A paused workspace is never a candidate or ready to close. First ships " +
        "merged PRs a release tag now contains, as `pr status` does. Drops `skip` workspaces " +
        "(and non-`focus` ones when any carry `focus`), names the `candidates` that need a " +
        "courier and the `readyToClose` ones (shipped or abandoned, no Claude turn working). " +
        "Marks now as the last check-in.",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await checkInTriage();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        "rough USD estimate (rates from ~/.werkmeister/model-pricing.yaml). On-demand.",
      inputSchema: { ...WORKSPACE_ARG },
      annotations: { readOnlyHint: true },
      outputSchema: {
        name: z.string(),
        totals: z.object({
          input: z.number(),
          output: z.number(),
          cacheCreation: z.number(),
          cacheRead: z.number(),
        }),
        estUsd: z.number().nullable(),
        byModel: z.array(
          z.object({
            model: z.string(),
            totals: z.object({
              input: z.number(),
              output: z.number(),
              cacheCreation: z.number(),
              cacheRead: z.number(),
            }),
            estUsd: z.number().nullable(),
          }),
        ),
        sessions: z.array(
          z.object({
            sessionId: z.string(),
            title: z.string(),
            updatedAt: z.string(),
            totals: z.object({
              input: z.number(),
              output: z.number(),
              cacheCreation: z.number(),
              cacheRead: z.number(),
            }),
            estUsd: z.number().nullable(),
          }),
        ),
      },
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const { name } = resolveWorkspace(args.workspace, headersOf(extra));
        const usage = await getWorkspaceUsage(name);
        const tot =
          usage.totals.input +
          usage.totals.output +
          usage.totals.cacheCreation +
          usage.totals.cacheRead;
        const dollars = usage.estUsd == null ? "" : ` · ~$${usage.estUsd.toFixed(2)}`;
        const models = usage.byModel.map((m) => m.model).join(", ") || "none";
        const text = `${name}: ${tot.toLocaleString()} tokens${dollars} across ${usage.sessions.length} session(s) [${models}]`;
        return {
          content: [{ type: "text", text }],
          structuredContent: usage as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ provider: z.string(), url: z.string().nullable() }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getDockerUi();
        return {
          content: [
            {
              type: "text",
              text: `Docker: ${result.provider}${result.url ? ` — ${result.url}` : " (no browser UI)"}`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        "Check every default k8s port-forward (from ~/.werkmeister/services.yaml): HTTP GET " +
        "on each forward's health endpoint (2xx/3xx = healthy), or a TCP connect when it has " +
        "none. Returns per-forward health plus healthy/total counts; `stopped` when the " +
        "forwarder is down and no running workspace needs the cluster (normal, not a fault).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
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
        stopped: z.boolean(),
      }),
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await getK8sForwardsHealth();
        const bad = result.forwards.filter((f) => !f.healthy).map((f) => `${f.name} (${f.detail})`);
        const text = result.stopped
          ? "k8s-forwards stopped — not needed by any running workspace."
          : `${result.healthy}/${result.total} k8s forwards healthy` +
            (bad.length ? ` — unhealthy: ${bad.join(", ")}` : ".");
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
      annotations: { readOnlyHint: true },
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
        return fail(e);
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
      annotations: { readOnlyHint: false },
      outputSchema: z.object({
        context: z.string(),
        env: z.enum(["dev", "stage", "prod", "other"]),
      }),
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await switchKubeContext(args.env ?? "dev");
        return {
          content: [
            { type: "text", text: `Switched kube context to ${result.context} [${result.env}]` },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        "sessionId is null when the workspace has no sessions yet. Pass the `workspace` " +
        "from `list-workspaces`.",
      inputSchema: {
        ...SESSION_ARG,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (default 20)."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Read this specific session instead of the newest (from `sessions[]`); stale/unknown ids fall back to newest.",
          ),
      },
      annotations: { readOnlyHint: true },
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
        sessions: z
          .array(
            z.object({
              sessionId: z.string(),
              title: z.string(),
              updatedAt: z.string(),
              isNewest: z.boolean(),
            }),
          )
          .describe(
            "All sessions for this workspace, newest first — drives the chat panel's session picker.",
          ),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const [result, sessions] = await Promise.all([
          getClaudeTranscript(name, args.limit ?? 20, args.sessionId),
          listSessions(name),
        ]);
        const text = result.sessionId
          ? `Session ${result.sessionId} (${result.messages.length} recent messages, ${result.sessionCount} session(s) total).`
          : `No Claude Code sessions found for ${name}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { ...result, sessions } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        ...SESSION_ARG,
        message: z.string().describe("The message to send."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Resume this specific session instead of the newest; `--resume` bumps it back to newest afterwards.",
          ),
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({
        sessionId: z.string().nullable(),
        started: z.boolean(),
        startedNew: z.boolean(),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await sendToClaudeSession(name, args.message, args.sessionId);
        const text = result.startedNew
          ? "Started a new session; poll claude-transcript for the reply."
          : `Turn started on session ${result.sessionId}; poll claude-transcript for the reply.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        ...SESSION_ARG,
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        state: z.enum(["idle", "running", "done", "failed"]),
        startedAt: z.string().nullable(),
        exitCode: z.number().nullable(),
        error: z.string().nullable(),
      }),
      _meta: APP_ONLY,
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await getClaudeTurnStatus(name);
        return {
          content: [
            {
              type: "text",
              text: `Turn state for ${name}: ${result.state}${result.error ? ` (${result.error})` : ""}`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
        "when the workspace has none, or when `new` is set.",
      inputSchema: {
        ...SESSION_ARG,
        sessionId: z
          .string()
          .optional()
          .describe("Resume this specific session instead of the newest."),
        new: z
          .boolean()
          .optional()
          .describe("Start a fresh session instead of resuming one; ignores `sessionId`."),
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({
        path: z.string(),
        sessionId: z.string().nullable(),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await resumeClaudeInTerminal(name, args.sessionId, args.new === true);
        const text = result.sessionId
          ? `Opened Terminal resuming session ${result.sessionId} in ${result.path}.`
          : `Opened Terminal with a new Claude session in ${result.path}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
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
      const html = readAppHtml("mcp-app.html");
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
      const html = readAppHtml("mcp-list.html");
      return {
        contents: [{ uri: RESOURCE_URI_LIST, mimeType: RESOURCE_MIME_TYPE, text: html }],
      };
    },
  );
}
