/**
 * Bundle the CLI to self-contained ESM, so the published package installs
 * without resolving a private workspace.
 *
 * `werkmeister-core` is a private monorepo workspace: an `npm i -g` of this package
 * could never resolve it, so it (and `commander`/`yaml`/`nunjucks`/`@inquirer`)
 * are bundled in rather than declared as runtime dependencies. That is what
 * makes the tarball installable from a checkout-free machine.
 *
 * One entry per thing the wrapper or `infra connect` execs: the hook entries
 * (`dist/lib/gate.js` etc.) skip the commander/yaml import chain (<200ms
 * budget — see gate.ts); bundling would otherwise collapse them into one file
 * and hand the gate the whole CLI's import cost on every Edit/Write. `mcp`
 * (`dist/mcp.js`) is the daemon and `mcp-proxy` (`dist/mcp-proxy.js`) the stdio
 * proxy `werkmeister internal mcp` runs (SW-344): both live in the sibling
 * `apps/werkmeister-mcp` workspace, which is private and not published, so they are
 * bundled here from source — the same reason werkmeister-core is. Without them the
 * daemon and the `werkmeister` plugin's MCP entry have no target on an
 * `npm i -g` install. `dashboard` and `form-cli` are `apps/werkmeister-dashboard`'s
 * two entries, bundled for the same reason; the single-file pages both apps'
 * vite builds emit are copied in beside them (UI_PAGES).
 *
 * `dockerode` and `@anthropic-ai/claude-agent-sdk` are the exceptions, left
 * external and declared in package.json, the SDK as an optional dependency (its reason is
 * at `external` below). For dockerode: 046 bundled it into the .vsix by externalising `*.node`, but that
 * bundle is CJS; this one is ESM, where esbuild rewrites an unresolved `require`
 * into a shim that throws rather than the guarded miss dockerode's ssh2 ->
 * cpu-features path relies on. Letting npm install it keeps the native
 * resolution npm-shaped. `*.node` stays listed so anything else reaching a
 * binding fails at build, not at a user's first `werkmeister feature up`.
 *
 * `splitting` moves code two or more entries share into `dist/chunk-<hash>.js`
 * files they import, rather than a copy in each, and gives each command main.ts
 * imports lazily its own `dist/<command>-<hash>.js`: 8.7 MB of entries
 * otherwise, 3 MB split. Both stay in dist/ itself, not a subfolder, because
 * bundled code resolves paths from `import.meta.dirname` and that must stay
 * `dist`. The hash renames a file whenever it changes, so `pruneChunks` deletes
 * every dist/*.js a build no longer emits. Only main.ts imports lazily (one
 * command, at start), so a process that is already running never asks for a
 * pruned file.
 *
 * Output stays ESM (the extension's bundle is CJS and has to `define`
 * import.meta away): werkmeister-core resolves paths through `import.meta.dirname`,
 * which is native here.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
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

const pruneChunks = {
  name: "prune-chunks",
  setup(build) {
    build.onEnd(({ metafile }) => {
      if (!metafile) return; // a failed build: keep what the last good one emitted
      const emitted = new Set(Object.keys(metafile.outputs).map((f) => basename(f)));
      for (const f of readdirSync("dist")) {
        if (/\.js(\.map)?$/.test(f) && !emitted.has(f)) rmSync(`dist/${f}`);
      }
    });
  },
};

const options = {
  entryPoints: [
    { in: "src/main.ts", out: "main" },
    { in: "src/lib/gate.ts", out: "lib/gate" },
    { in: "src/lib/pr_guard.ts", out: "lib/pr_guard" },
    { in: "src/lib/agent_state.ts", out: "lib/agent_state" },
    { in: "../werkmeister-mcp/src/main.ts", out: "mcp" },
    { in: "../werkmeister-mcp/src/proxy.ts", out: "mcp-proxy" },
    { in: "../werkmeister-dashboard/src/main.ts", out: "dashboard" },
    { in: "../werkmeister-dashboard/src/form-cli.ts", out: "form-cli" },
  ],
  bundle: true,
  splitting: true,
  plugins: [pruneChunks],
  outdir: "dist",
  // The Agent SDK runs a bundled Claude Code binary it locates relative to its
  // own package, so it stays an installed dependency rather than bundled code.
  // chokidar is nunjucks' optional peer, required only for template watching,
  // which we never use; pnpm's hidden hoist would otherwise let esbuild bundle one.
  // The SQS client (SW-583) loads only when github_ingest is configured; several of its
  // packages ship no licence file, so it stays installed rather than bundled.
  external: [
    "dockerode",
    "*.node",
    "@anthropic-ai/claude-agent-sdk",
    "chokidar",
    "@aws-sdk/client-sqs",
  ],
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

// Read at runtime from beside the bundle. A missing one means the sibling app
// is unbuilt: turbo orders that through this package's devDependencies.
const UI_PAGES = [
  "../werkmeister-mcp/dist/mcp-app.html",
  "../werkmeister-mcp/dist/mcp-list.html",
  "../werkmeister-dashboard/dist/browser.html",
  "../werkmeister-dashboard/dist/form.html",
];
mkdirSync("dist", { recursive: true });
for (const page of UI_PAGES) copyFileSync(page, `dist/${page.split("/").pop()}`);

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  writeLicenses((await esbuild.build(options)).metafile, {
    outDir: "dist",
    bundled: "dist/*.js",
  });
}
