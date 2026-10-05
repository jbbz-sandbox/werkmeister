/**
 * MCP App (inline `ui://`) entrypoint for the shared workspace UI
 * (src/workspace-ui.ts) — the fallback surface when Cowork live artifacts
 * aren't available. Rendered inline by hosts that support MCP App UI (Claude
 * Desktop) when the `list-workspaces` tool is called.
 *
 * Same UI as the Cowork artifact (dist/workspace-list.artifact.html); only
 * the transport differs: server tools go through `app.callServerTool` with
 * bare tool names, and external links through `app.openLink` (the webview
 * blocks bare anchors).
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initWorkspaceUI, type HostBridge } from "./workspace-ui.js";

const app = new App({ name: "Sandbox Workspaces", version: "0.2.0" });

function textOf(result: CallToolResult): string {
  const part = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  return part?.text ?? "Tool call failed.";
}

const bridge: HostBridge = {
  async callTool(name, args) {
    const res = await app.callServerTool({ name, arguments: args ?? {} });
    if (res.isError) throw new Error(textOf(res));
    return res.structuredContent ?? JSON.parse(textOf(res));
  },
  openLink(url) {
    app.openLink({ url }).catch(() => {});
  },
  // No `streamSession`: the ext-apps webview has no localhost origin to hold an
  // SSE socket, so buildChat falls back to claude-transcript polling.
};

function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

app.onteardown = async () => ({});
app.onerror = console.error;
app.onhostcontextchanged = handleHostContextChanged;
// The shared UI fetches its own data via list-workspaces; the initial tool
// result that opened this view is redundant, so it's intentionally ignored.
app.ontoolresult = () => {};

await app.connect();
const ctx = app.getHostContext();
if (ctx) handleHostContextChanged(ctx);

initWorkspaceUI(bridge, document.getElementById("app")!);
