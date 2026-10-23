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
 *  - dockerode's docker.js eagerly requires ./session, which requires
 *    `@grpc/grpc-js` and `@grpc/proto-loader`. Those serve only BuildKit auth
 *    sessions (`buildImage` with `authconfig`), which the extension never opens.
 *    They are stubbed rather than externalised: a .vsix ships no node_modules, so
 *    an external require would throw at load and break activation, and a bundle
 *    that needs them installed crash-loops the watch container when they are
 *    missing (SW-38).
 *  - werkmeister-core is ESM and uses `import.meta.dirname` for its walk-up path
 *    resolution. A CJS bundle has no import.meta, so it is defined to __dirname.
 *    That makes the walk-up search the extension's dist/ and find nothing —
 *    fine, because the config.yaml tier added in Task 1 sits above it.
 */
import * as esbuild from "esbuild";
import { writeLicenses } from "../../scripts/write-licenses.mjs";

const watch = process.argv.includes("--watch");

// ponytail: a require of these returns {}; add a throwing stub if a gRPC path is ever reached.
const stubGrpc = {
  name: "stub-grpc",
  setup(build) {
    build.onResolve({ filter: /^@grpc\// }, (args) => ({
      path: args.path,
      namespace: "stub-grpc",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-grpc" }, () => ({
      contents: "module.exports = {};",
    }));
  },
};

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  external: ["vscode", "*.node"],
  plugins: [stubGrpc],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true,
  metafile: true,
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
  // The package root, not dist/: vsce only recognises LICENSE there (SW-74).
  writeLicenses((await esbuild.build(options)).metafile, {
    outDir: ".",
    bundled: "dist/extension.cjs",
  });
}
