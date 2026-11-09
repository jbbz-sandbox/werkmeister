import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import config from "./.vitepress/config.mjs";

const ROOT = join(import.meta.dirname, "../..");
const pages = config.themeConfig.sidebar.flatMap((g) =>
  g.items.map((i) => `${i.link.slice(1)}.md`),
);
// The pre-SW-591 framing: the original company app, the old subtitle, the stale Node floor, one tracker.
const OLD = /~15 services|Multi-Feature Concurrent Development|must be 20\+|tickets from Jira/;

test("the site Overview is docs/overview.md, not the repo README (SW-591)", () => {
  assert.ok(pages.includes("docs/overview.md"));
  assert.ok(!pages.includes("README.md"));
});

test("no site page keeps the old product framing (SW-591)", () => {
  const hits = pages.filter((f) => OLD.test(readFileSync(join(ROOT, f), "utf8")));
  assert.deepEqual(hits, []);
});

test("the pages that open with the product story quote the landing tagline (SW-591)", () => {
  for (const f of ["docs/overview.md", "docs/users-guide.md", "docs/werkmeister-architecture.md"])
    assert.ok(readFileSync(join(ROOT, f), "utf8").includes(config.description), f);
});
