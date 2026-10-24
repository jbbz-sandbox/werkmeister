import { existsSync, globSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { repoLinks } from "../repo-links.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const REPO = "https://github.com/jbbz-sandbox/werkmeister";

/** The sidebar, and the only repo docs the site builds: they stay where they are. */
const GROUPS = [
  [
    "Start",
    [
      ["Overview", "README.md"],
      ["Users guide", "docs/users-guide.md"],
      ["Workspace lifecycle", "docs/workspace-lifecycle.md"],
    ],
  ],
  [
    "How it works",
    [
      ["Topology", "docs/topology.md"],
      ["Architecture", "docs/sandbox-architecture.md"],
      ["Claude Code plugin", "plugins/werkmeister/README.md"],
    ],
  ],
  [
    "Help",
    [
      ["Troubleshooting", "docs/troubleshooting-advanced.md"],
      ["Known issues", "docs/known-issues.md"],
      ["Docker resources", "docs/docker-resource-optimization.md"],
      ["Jira REST setup", "docs/jira-rest-setup.md"],
    ],
  ],
  ["Project", [["Third-party software", "docs/third-party.md"]]],
];
const PAGES = [
  "apps/docs-site/index.md",
  ...GROUPS.flatMap(([, items]) => items.map(([, f]) => f)),
];

// Docs outside this package would resolve `vue` from their own folder, where there is none.
const VUE = dirname(createRequire(import.meta.resolve("vitepress")).resolve("vue/package.json"));

export default defineConfig({
  title: "Werkmeister",
  description: "Multi-feature concurrent development orchestrator",
  srcDir: ROOT,
  srcExclude: globSync("**/*.md", { cwd: ROOT, exclude: ["**/node_modules/**", ".git/**"] }).filter(
    (f) => !PAGES.includes(f),
  ),
  rewrites: { "apps/docs-site/index.md": "index.md" },
  outDir: "dist",
  base: "/",
  cleanUrls: true,
  vite: {
    resolve: { alias: [{ find: /^vue(?=$|\/)/, replacement: VUE }] },
    // Extra dev-server hosts, comma-separated: the workspace service sets it for
    // its Caddy hostname. Unset keeps Vite's localhost-only default.
    server: { allowedHosts: process.env.DOCS_ALLOWED_HOSTS?.split(",") },
  },
  markdown: {
    config: (md) =>
      repoLinks(md, {
        root: ROOT,
        pages: PAGES,
        repoUrl: `${REPO}/blob/main/`,
        exists: existsSync,
      }),
  },
  themeConfig: {
    search: { provider: "local" },
    nav: [{ text: "Guide", link: "/docs/users-guide" }],
    socialLinks: [{ icon: "github", link: REPO }],
    sidebar: GROUPS.map(([text, items]) => ({
      text,
      items: items.map(([t, f]) => ({ text: t, link: `/${f.replace(/\.md$/, "")}` })),
    })),
  },
});
