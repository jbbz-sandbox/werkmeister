// SW-1019: the snapshot script writes a quiet and a busy page with the view's CSS, the strip and every card.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { VIEW_CSS } from "../out/view-css.js";
import { writeSnapshots } from "../scripts/render-snapshots.mjs";
import { snapshot } from "../scripts/snapshot-fixture.mjs";

test("writes quiet.html and busy.html: the view's CSS, theme colours, the strip and one card per workspace", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "w9r-snap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = writeSnapshots(dir);
  assert.deepEqual(files, [join(dir, "quiet.html"), join(dir, "busy.html")]);
  for (const [kind, file] of [
    ["quiet", files[0]],
    ["busy", files[1]],
  ]) {
    const html = readFileSync(file, "utf8");
    assert.ok(html.includes(VIEW_CSS), `${kind}: the view's own CSS`);
    assert.match(html, /--vscode-sideBar-background:#181818/);
    assert.match(html, /class="strip"/);
    for (const w of snapshot(kind).statuses) assert.ok(html.includes(w.name), `${kind}: ${w.name}`);
  }
  // The busy strip carries every kind of chip a layout has to fit.
  const busy = readFileSync(files[1], "utf8");
  for (const chip of [
    "3 need you",
    "running",
    "2 waiting",
    "infra: caddy, k8s-forwards down",
    "CI failed or conflicts",
  ])
    assert.ok(busy.includes(chip), chip);
});
