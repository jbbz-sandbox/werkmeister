/**
 * Cowork live-artifact entrypoint for the shared workspace UI
 * (src/workspace-ui.ts). Built to dist/workspace-list.artifact.html; install
 * it by asking Claude in a Cowork session to create an artifact from that
 * file (see the install-workspace-dashboard skill / README).
 *
 * Talks to the Sandbox MCP server through the `window.cowork` bridge that the
 * Cowork artifact host injects. Tool names are fully qualified as
 * `mcp__<server>__<tool>`; the prefix is read at runtime from the
 * cowork-artifact-meta block in this document, which the build generates from
 * src/artifact-meta.json — change "serverName" there and rebuild if your MCP
 * server is registered under a different name.
 */
import { appRoot } from "./theme.js";
import { type HostBridge, initWorkspaceUI } from "./workspace-ui.js";

// The meta block is what grants this artifact MCP tool access, so whatever
// prefix it declares is by definition the one the bridge accepts.
function serverPrefix(): string {
  try {
    const meta = JSON.parse(document.getElementById("cowork-artifact-meta")?.textContent ?? "") as {
      mcpTools?: string[];
    };
    const tool = meta.mcpTools?.[0] ?? "";
    const end = tool.lastIndexOf("__");
    if (tool.startsWith("mcp__") && end > 3) return tool.slice(0, end + 2);
  } catch {
    // fall through to default
  }
  return "mcp__werkmeister__";
}

const SERVER_PREFIX = serverPrefix();

declare global {
  interface Window {
    cowork?: {
      callMcpTool(
        name: string,
        args: Record<string, unknown>,
      ): Promise<{
        isError?: boolean;
        structuredContent?: unknown;
        content?: Array<{ type: string; text?: string }>;
      }>;
    };
  }
}

/**
 * The window.cowork bridge is injected asynchronously and may not exist yet
 * when this script first runs (e.g. reopening the artifact in a new session).
 */
function waitForBridge(timeoutMs = 45000): Promise<NonNullable<Window["cowork"]>> {
  return new Promise((resolve, reject) => {
    if (window.cowork && typeof window.cowork.callMcpTool === "function")
      return resolve(window.cowork);
    const start = Date.now();
    const iv = setInterval(() => {
      if (window.cowork && typeof window.cowork.callMcpTool === "function") {
        clearInterval(iv);
        resolve(window.cowork);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error("connection to Cowork not available"));
      }
    }, 100);
  });
}

const bridge: HostBridge = {
  async callTool(name, args) {
    const cowork = await waitForBridge();
    const r = await cowork.callMcpTool(SERVER_PREFIX + name, args ?? {});
    if (r.isError) throw new Error(name + " returned an error");
    return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "null");
  },
  openLink(url) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  },
  // No `streamSession`: the sandboxed Cowork artifact iframe (strict CSP, no
  // server) can't hold an SSE socket, so buildChat falls back to
  // claude-transcript polling.
};

initWorkspaceUI(bridge, appRoot());
