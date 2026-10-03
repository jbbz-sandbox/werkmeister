// The last gate before a write: the JSON Schema, then a trial merge against
// every other repo's fragment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { planFragment, renderFragment, validateFragment, writeFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({ reposRoot: path.dirname(root), runner: noTools, localPath: "/nonexistent", portsPerSlot: 20 });
const SHOP = { "package.json": { name: "shop", scripts: { dev: "node ." }, dependencies: { express: "4" } } };

test("a generated fragment is valid", () => {
  const root = fixture(SHOP, "shop");
  const plan = planFragment(root, opts(root));
  assert.deepEqual(validateFragment(renderFragment(plan), plan, path.dirname(root)), []);
});

test("a service name another repo already has fails the trial merge", () => {
  const root = fixture(SHOP, "shop");
  const other = path.join(path.dirname(root), "legacy", ".sandbox");
  mkdirSync(other, { recursive: true });
  writeFileSync(path.join(other, "services.yaml"), "services:\n  shop:\n    path: .\n    port_offset: 19\n");
  const plan = planFragment(root, opts(root));
  const errors = validateFragment(renderFragment(plan), plan, path.dirname(root));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /services\.shop is defined by both legacy and shop/);
});

test("a schema violation is reported with its path", () => {
  const root = fixture(SHOP, "shop");
  const plan = planFragment(root, opts(root));
  const rendered = renderFragment(plan);
  const broken = { ...rendered, yaml: rendered.yaml.replace("type: api", "type: daemon") };
  const errors = validateFragment(broken, plan, path.dirname(root));
  assert.ok(errors.some((e) => e.startsWith("/services/shop/type")), errors.join("\n"));
});

test("writeFragment creates .sandbox/ and writes the text", () => {
  const root = fixture(SHOP, "shop");
  const rendered = renderFragment(planFragment(root, opts(root)));
  assert.ok(!existsSync(rendered.path));
  writeFragment(rendered);
  assert.equal(readFileSync(rendered.path, "utf8"), rendered.yaml);
});
