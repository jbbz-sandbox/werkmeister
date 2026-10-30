/**
 * Bundle the CLI to self-contained ESM, so the published package installs
 * without resolving a private workspace.
 *
 * `werkmeister-core` is a private monorepo workspace: an `npm i -g` of this package
 * could never resolve it, so it (and `commander`/`yaml`/`nunjucks`/`@inquirer`)
 * are bundled in rather than declared as runtime dependencies. That is what
 * makes the tarball installable from a checkout-free machine.
 *
 * Three entry points, because the wrapper has three: `hooks gate` execs
 * `dist/lib/gate.js` directly to skip the commander/yaml import chain (<200ms
 * budget — see gate.ts). Bundling would otherwise collapse them into one file
 * and hand the gate the whole CLI's import cost on every Edit/Write. `mcp`
 * execs `dist/mcp.js`: the headless MCP server lives in the sibling
 * `apps/werkmeister-mcp` workspace, which is private and not published, so it is bundled
 * here from source — the same reason werkmeister-core is. Without it, `werkmeister
 * mcp` and the `werkmeister` plugin's MCP entry have no target on an
 * `npm i -g` install.
 *
 * `dockerode` and `@anthropic-ai/claude-agent-sdk` are the exceptions, left
 * external and declared in package.json, the SDK as an optional dependency (its reason is
 * at `external` below). For dockerode: 046 bundled it into the .vsix by externalising `*.node`, but that
 * bundle is CJS; this one is ESM, where esbuild rewrites an unresolved `require`
 * into a shim that throws rather than the guarded miss dockerode's ssh2 ->
 * cpu-features path relies on. Letting npm install it keeps the native
 * resolution npm-shaped. `*.node` stays listed so anything else reaching a
 * binding fails at build, not at a user's first `werkmeister up`.
 *
 * Output stays ESM (the extension's bundle is CJS and has to `define`
 * import.meta away): werkmeister-core resolves paths through `import.meta.dirname`,
 * which is native here.
 */
import { execFileSync } from "node:child_process";
import * as esbuild from "esbuild";
import { writeLicenses } from "../../scripts/write-licenses.mjs";

const watch = process.argv.includes("--watch");

// The source commit, so a linked dev CLI can warn when dist is older than the
// checkout (src/lib/build_freshness.ts). Empty outside a git checkout.
function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
const buildStamp = { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" };

const options = {
  entryPoints: [
    { in: "src/main.ts", out: "main" },
    { in: "src/lib/gate.ts", out: "lib/gate" },
    { in: "src/lib/pr_guard.ts", out: "lib/pr_guard" },
    { in: "src/lib/agent_state.ts", out: "lib/agent_state" },
    { in: "../werkmeister-mcp/src/main.ts", out: "mcp" },
  ],
  bundle: true,
  outdir: "dist",
  // The Agent SDK runs a bundled Claude Code binary it locates relative to its
  // own package, so it stays an installed dependency rather than bundled code.
  // chokidar is nunjucks' optional peer, required only for template watching,
  // which we never use; pnpm's hidden hoist would otherwise let esbuild bundle one.
  external: ["dockerode", "*.node", "@anthropic-ai/claude-agent-sdk", "chokidar"],
  // jsonc-parser's `main` is UMD, which loads its own files with a dynamic
  // require esbuild can't follow; its ESM build is plain imports.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  // SW-180: each command's help.md is embedded in its --help.
  loader: { ".md": "text" },
  format: "esm",
  platform: "node",
  target: "node22",
  define: { __SANDBOX_BUILD__: JSON.stringify(buildStamp) },
  sourcemap: true,
  metafile: true,
  // SW-58: smaller package, faster load. keepNames keeps function/class names in
  // stack traces and `constructor.name`; legalComments stays at the bundling default
  // (`eof`) — `none` would drop the MIT/Apache notices the bundled deps require.
  minify: true,
  keepNames: true,
  // commander and nunjucks are CJS, and ESM output has no `require` for their
  // internal `require("node:events")` calls — esbuild's shim throws "Dynamic
  // require ... is not supported". Its shim delegates to a real `require` when
  // one is in scope, so defining one is the whole fix.
  banner: {
    js:
      'import { createRequire as __sandboxCreateRequire } from "node:module";\n' +
      "const require = __sandboxCreateRequire(import.meta.url);",
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  writeLicenses((await esbuild.build(options)).metafile, {
    outDir: "dist",
    bundled: "dist/*.js",
  });
}
