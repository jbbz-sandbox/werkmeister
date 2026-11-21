// SW-623: the pane painter's layout rules, on small trees (no Claude Code, no spawn).
import assert from "node:assert/strict";
import { test } from "node:test";
import { cellWidth, paint, toAnsi } from "./render-pane.mjs";

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
