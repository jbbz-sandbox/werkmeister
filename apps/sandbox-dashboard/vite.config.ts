import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import artifactMeta from "./src/artifact-meta.json";

// Expands src/artifact-meta.json (server name written ONCE) into the
// cowork-artifact-meta block that Cowork reads to grant MCP tool access.
// src/artifact-main.ts derives its tool-name prefix from the same block at
// runtime, so the server name has a single source of truth.
function coworkArtifactMeta(): Plugin {
  const { serverName, tools, ...rest } = artifactMeta;
  const meta = {
    ...rest,
    mcpTools: tools.map((t) => `mcp__${serverName}__${t}`),
    mcpServerNames: tools.map(() => serverName),
  };
  return {
    name: "cowork-artifact-meta",
    transformIndexHtml(html) {
      return html.replace("__COWORK_ARTIFACT_META__", JSON.stringify(meta, null, 2));
    },
  };
}

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

const isDevelopment = process.env.NODE_ENV === "development";

// Bundles the UI (HTML + TS + CSS) into a single self-contained dist/mcp-app.html
// that the MCP server serves as a `ui://` resource.
export default defineConfig({
  plugins: [coworkArtifactMeta(), viteSingleFile()],
  // npm workspaces hoist @rjsf/* to the repo root, where `react` resolves to
  // frontend's 19.x while our own imports resolve to this app's 18.x. Two
  // Reacts in one bundle means RJSF's elements fail the host React's element
  // check ("Objects are not valid as a React child") and the form never renders.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    // The UI runs only in the host's modern Chromium webview (Claude Desktop),
    // so a modern target is safe — and enables top-level await.
    target: "es2022",
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: {
      input: INPUT,
    },
    outDir: "dist",
    emptyOutDir: false,
  },
});
