/**
 * MCP App (inline `ui://`) entrypoint for the create-workspace form
 * (werkmeister-ui/create-form) — rendered inline by hosts that support MCP App UI
 * (Claude Desktop) when the `create-workspace-form` tool is called.
 *
 * Same neutral form as the browser dashboard's "New workspace" tab and the
 * localhost fallback page; only the transport differs:
 *   • the RJSF bundle arrives via `ontoolresult` (with any issue pre-fill
 *     merged by the server), so the bridge answers `workspace-form-schema`
 *     locally instead of re-fetching (which would lose the pre-fill);
 *   • server tools go through `app.callServerTool` with bare tool names, and
 *     external links through `app.openLink`;
 *   • a successful create quietly informs the model via `updateModelContext`.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { initCreateForm } from "werkmeister-ui/create-form";
import { appRoot } from "werkmeister-ui/theme";
import type { HostBridge } from "werkmeister-ui/workspace-ui";

const app = new App({ name: "Initialize Workspace", version: "0.1.0" });

function textOf(result: CallToolResult): string {
  const part = result.content?.find((c) => c.type === "text") as { text?: string } | undefined;
  return part?.text ?? "Tool call failed.";
}

let bundle: Record<string, unknown> | undefined;

const bridge: HostBridge = {
  async callTool(name, args) {
    if (name === "workspace-form-schema") return bundle;
    const res = await app.callServerTool({ name, arguments: args ?? {} });
    if (res.isError) throw new Error(textOf(res));
    return res.structuredContent ?? JSON.parse(textOf(res));
  },
  openLink(url) {
    app.openLink({ url }).catch(() => {});
  },
};

// Match the other surfaces' page chrome (see apps/werkmeister-dashboard/src/form-main.ts).
const BODY_GAP = 16;
document.body.style.cssText = `margin:0;background:#f7f7f5;padding:${BODY_GAP}px`;
const root = appRoot();
root.style.cssText = "max-width:720px;margin:0 auto";

function handleHostContextChanged(ctx: McpUiHostContext): void {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  // Safe-area insets pad the outer body on top of the base gap.
  if (ctx.safeAreaInsets) {
    const s = ctx.safeAreaInsets;
    document.body.style.padding = `${BODY_GAP + s.top}px ${BODY_GAP + s.right}px ${BODY_GAP + s.bottom}px ${BODY_GAP + s.left}px`;
  }
}

app.onteardown = async () => ({});
app.onerror = console.error;
app.onhostcontextchanged = handleHostContextChanged;

// The initial `create-workspace-form` result delivers the RJSF bundle.
app.ontoolresult = (result: CallToolResult) => {
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (!data?.schema) return;
  bundle = data;
  initCreateForm(bridge, root, {
    onCreated: (text) => {
      // Quietly inform the model for the next turn without drafting a user
      // message into the composer.
      void app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
    },
  });
};

await app.connect();
const ctx = app.getHostContext();
if (ctx) handleHostContextChanged(ctx);
