import assert from "node:assert/strict";
import { test } from "node:test";
import config from "./.vitepress/config.mjs";

const { nav: allNav, sidebar: sidebars } = config.themeConfig;
const nav = allNav.slice(0, -1);
const sidebar = sidebars["/"];
const links = (groups) => groups.flatMap((g) => g.items.map((i) => i.link));

test("nav has one dropdown per sidebar group, reaching every sidebar page once", () => {
  assert.deepEqual(
    nav.map((g) => g.text),
    sidebar.map((g) => g.text),
  );
  assert.deepEqual(links(nav), links(sidebar));
  assert.equal(new Set(links(nav)).size, links(nav).length);
});

test("the nav ends with the SDK reference, which has its own sidebar", () => {
  assert.deepEqual(allNav.at(-1), { text: "SDK", link: "/sdk/" });
  assert.equal(sidebars["/sdk/"][0].link, "/sdk/");
});
