import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const INPUT = process.env.INPUT;
if (!INPUT) {
  throw new Error("INPUT environment variable is not set");
}

const isDevelopment = process.env.NODE_ENV === "development";

// Bundles one MCP App page (mcp-app.html or mcp-list.html) and its werkmeister-ui
// modules into a single self-contained dist/<page>.html, served as a `ui://` resource.
export default defineConfig({
  plugins: [viteSingleFile()],
  // Two copies of React would break RJSF's element check; see apps/werkmeister-dashboard/vite.config.ts.
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    // Claude Desktop's modern Chromium webview is the only host.
    target: "es2022",
    sourcemap: isDevelopment ? "inline" : undefined,
    cssMinify: !isDevelopment,
    minify: !isDevelopment,
    rollupOptions: { input: INPUT },
    outDir: "dist",
    // tsc has already written the server to dist/.
    emptyOutDir: false,
  },
});
