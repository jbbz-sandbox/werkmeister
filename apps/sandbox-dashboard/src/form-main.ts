/**
 * Standalone-page entrypoint for the create-workspace form — the localhost
 * fallback served by lib/localhost-form.ts to MCP hosts that don't render
 * `ui://` resources (Claude Code CLI, the VS Code extension).
 *
 * Renders the SAME form as the dashboard's "New workspace" tab
 * (src/create-form.ts) over the same fetch bridge as browser-main.ts. The
 * serving side is a throwaway blocking server: it answers
 * `workspace-form-schema` and `refine-prompt`, and intercepts
 * `create-workspace` / `cancel-form` to resolve the caller's
 * promptViaLocalhostForm() promise — the actual create runs in the caller
 * (form-cli.ts) after this page submits.
 */
import { initCreateForm } from "./create-form.js";
import { appRoot } from "./theme.js";
import type { HostBridge } from "./workspace-ui.js";

const bridge: HostBridge = {
  async callTool(name, args) {
    const r = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, arguments: args ?? {} }),
    });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || `${name} failed`);
    return d.structuredContent ?? JSON.parse(d.content?.[0]?.text ?? "null");
  },
  openLink(url) {
    window.open(url, "_blank", "noopener");
  },
};

document.body.style.cssText = "margin:0;background:#f7f7f5";
const root = appRoot();
root.style.cssText = "max-width:720px;margin:0 auto";

initCreateForm(bridge, root, {
  onCreated: () => {},
  onCancel: () => {
    // Best-effort: the server settles as "cancelled" and shuts down.
    void bridge.callTool("cancel-form").catch(() => {});
    root.innerHTML =
      '<div class="card" style="margin:20px;padding:20px"><h1>Cancelled</h1>' +
      "<p>Nothing was created — you can return to Claude.</p></div>";
  },
});
