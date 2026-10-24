import assert from "node:assert/strict";
import { test } from "node:test";
import { createMarkdownRenderer } from "vitepress";
import { repoLinks } from "./repo-links.mjs";

const root = "/repo";
const md = await createMarkdownRenderer(root, {
  config: (md) =>
    repoLinks(md, {
      root,
      pages: ["README.md", "docs/guide.md"],
      repoUrl: "https://github.com/o/r/blob/main/",
      exists: (p) => ["/repo/LICENSE", "/repo/apps/cli", "/repo/docs/guide.md"].includes(p),
    }),
});
const hrefs = (src) =>
  [...md.render(src, { path: "/repo/docs/topology.md" }).matchAll(/href="([^"]*)"/g)].map(
    (m) => m[1],
  );

test("an existing non-page file goes to GitHub, keeping its hash", () => {
  assert.deepEqual(hrefs("[l](../LICENSE) [c](../apps/cli#run)"), [
    "https://github.com/o/r/blob/main/LICENSE",
    "https://github.com/o/r/blob/main/apps/cli#run",
  ]);
});

test("a page stays a site link", () => {
  assert.doesNotMatch(hrefs("[g](guide.md#a)")[0], /github\.com/);
});

test("a missing target is left for the dead-link check", () => {
  assert.doesNotMatch(hrefs("[x](gone.md) [y](../apps/gone)").join(" "), /github\.com/);
});

test("URLs, anchors and site-absolute links are untouched", () => {
  const [url, anchor, absolute] = hrefs("[a](https://x.dev/LICENSE) [b](#top) [c](/LICENSE)");
  assert.equal(url, "https://x.dev/LICENSE");
  assert.equal(anchor, "#top");
  assert.doesNotMatch(absolute, /github\.com/);
});
