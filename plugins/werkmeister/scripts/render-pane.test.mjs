// SW-623: the pane painter's layout rules, on small trees (no Claude Code, no spawn).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserCaches, cellWidth, chrome, paint, toAnsi } from "./render-pane.mjs";

const text = (t, props = {}) => ({ type: "Text", props, children: [t] });
const box = (props, ...children) => ({ type: "Box", props, children });
const plain = (lines) => lines.map((l) => l.map((s) => s.t).join(""));

test("a round border spans the width it is given", () => {
  const [top, mid, bottom] = plain(paint(box({ borderStyle: "round" }, text("hi")), 20));
  assert.equal(top, `╭${"─".repeat(18)}╮`);
  assert.equal(mid, `│hi${" ".repeat(16)}│`);
  assert.equal(bottom, `╰${"─".repeat(18)}╯`);
});

test("space-between puts the last child at the right edge", () => {
  const [line] = plain(paint(box({ justifyContent: "space-between" }, text("a"), text("b")), 10));
  assert.equal(line, `a${" ".repeat(8)}b`);
});

test("flexWrap moves a button that does not fit to the next line", () => {
  const btn = (label) => ({ type: "Button", props: { label } });
  const lines = plain(paint(box({ flexWrap: "wrap", gap: 1 }, btn("one"), btn("two")), 12));
  assert.deepEqual(
    lines.map((l) => l.trimEnd()),
    ["[ one ]", "[ two ]"],
  );
});

test("an overflowing row shrinks its widest child, which wraps", () => {
  const tree = box({ justifyContent: "space-between" }, text("aaa bbb ccc"), {
    type: "Button",
    props: { label: "x" },
  });
  const lines = plain(paint(tree, 12));
  assert.deepEqual(lines, ["aaa bbb[ x ]", `ccc${" ".repeat(9)}`]);
});

test("full-width and emoji glyphs take two cells", () => {
  assert.equal(cellWidth("＋"), 2);
  assert.equal(cellWidth("⚡"), 2);
  assert.equal(cellWidth("✓ ☐"), 3);
});

test("no line is wider than the columns, and the same tree paints the same bytes", () => {
  const tree = box(
    { flexDirection: "column" },
    text("word ".repeat(40)),
    box({ borderStyle: "bold" }, text("x".repeat(90))),
  );
  const lines = paint(tree, 30);
  for (const l of lines) assert.ok(l.reduce((n, s) => n + cellWidth(s.t), 0) <= 30);
  assert.equal(toAnsi(lines), toAnsi(paint(tree, 30)));
});

// SW-1016: with-temp-home's HOME hides Playwright's cache, so the real home comes from the user database.
test("Chrome's caches are PLAYWRIGHT_BROWSERS_PATH, then the real home's, whatever $HOME says", (t) => {
  const home = process.env.HOME;
  t.after(() => {
    process.env.HOME = home;
  });
  process.env.HOME = mkdtempSync(join(tmpdir(), "w9r-home-"));
  const real = userInfo().homedir;
  assert.notEqual(real, process.env.HOME);
  assert.deepEqual(browserCaches({ PLAYWRIGHT_BROWSERS_PATH: "/pw" }), [
    "/pw",
    join(real, "Library/Caches/ms-playwright"),
    join(real, ".cache/ms-playwright"),
  ]);
  assert.deepEqual(browserCaches({}), browserCaches({ PLAYWRIGHT_BROWSERS_PATH: "/pw" }).slice(1));
});

test("chrome() takes CHROME first, then the first cache with a headless shell, newest build first", (t) => {
  const root = mkdtempSync(join(tmpdir(), "w9r-pw-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shell = (cache, build) => {
    const dir = join(root, cache, `chromium_headless_shell-${build}`, "chrome-mac");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "chrome-headless-shell");
    writeFileSync(bin, "");
    chmodSync(bin, 0o755);
    return bin;
  };
  shell("pw", 1200);
  const newest = shell("pw", 1255);
  const home = shell("home", 1300);
  const caches = [join(root, "pw"), join(root, "home"), join(root, "missing")];
  assert.equal(chrome({ CHROME: "/c" }, caches), "/c");
  assert.equal(chrome({}, caches), newest);
  assert.equal(chrome({}, caches.slice(1)), home);
  assert.equal(chrome({}, [join(root, "missing")]), null);
});
