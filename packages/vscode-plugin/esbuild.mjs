/**
 * Bundle the extension to a single CommonJS file.
 *
 * Two non-obvious requirements:
 *  - `sandbox-driver` is a private monorepo workspace, so a .vsix cannot resolve
 *    it at runtime — it (and its `yaml` dependency) must be bundled in, not
 *    externalised. Only `vscode` is external; the host provides it.
 *  - The driver is ESM and uses `import.meta.dirname` for its walk-up path
 *    resolution. A CJS bundle has no import.meta, so it is defined to __dirname.
 *    That makes the walk-up search the extension's dist/ and find nothing —
 *    fine, because the config.yaml tier added in Task 1 sits above it.
 */
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: { "import.meta.dirname": "__dirname", "import.meta.url": "__filename" },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
