/**
 * Bundle the extension to a single CommonJS file.
 *
 * Three non-obvious requirements:
 *  - `werkmeister-core` is a private monorepo workspace, so a .vsix cannot resolve
 *    it at runtime — it (and its `yaml` dependency) must be bundled in, not
 *    externalised. `vscode` is external; the host provides it.
 *  - `getWorkspaceStatuses` now reaches dockerode, which pulls in optional native
 *    binaries (`ssh2` -> `cpu-features`). esbuild has no loader for `.node`, so they
 *    are externalised: their `require`s sit inside `try {} catch {}`, so the .vsix
 *    ships without them and dockerode falls back to its pure-JS paths.
 *  - werkmeister-core is ESM and uses `import.meta.dirname` for its walk-up path
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
  external: ["vscode", "*.node"],
  format: "cjs",
  platform: "node",
  target: "node20",
  sourcemap: true,
  minify: false,
  define: { "import.meta.dirname": "__dirname", "import.meta.url": "__filename" },
  logLevel: "info",
  // jsonc-parser's `main` is a UMD build whose `require("./impl/format")` is
  // dynamic, so esbuild leaves it unbundled and activation throws. Its ESM
  // `module` entry bundles cleanly.
  mainFields: ["module", "main"],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
