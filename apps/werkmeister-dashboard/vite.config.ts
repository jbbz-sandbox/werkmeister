import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

const isDevelopment = process.env.NODE_ENV === "development";

// Bundles the UI (HTML + TS + CSS) into a single self-contained dist/mcp-app.html
// that the MCP server serves as a `ui://` resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  // Guard, not a fix for a live problem: npm workspaces hoist @rjsf/* to the
  // repo root, so whenever the root ends up with a different `react` than this
  // app's, RJSF resolves to that one and we ship two Reacts. RJSF's elements
  // then fail the host React's element check ("Objects are not valid as a React
  // child") and the form never renders. The tree is single-React today.
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
