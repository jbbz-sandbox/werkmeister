// The fragment schema's `repo:` block (ship detection, docs/workspace-lifecycle.md),
// compiled with the same Ajv options as fragment_detect/validate.ts.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { parse } from "yaml";

const Ajv = createRequire(import.meta.url)("ajv");
const schema = JSON.parse(
  fs.readFileSync(
    new URL("../../apps/cli/infra/schemas/services-fragment.schema.json", import.meta.url),
    "utf8",
  ),
);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const fragment = parse(
  fs.readFileSync(new URL("../../.sandbox/services.yaml", import.meta.url), "utf8"),
);
const { repo: _, ...withoutRepo } = fragment;

test("this repo's fragment, with and without its repo: block, is valid", () => {
  assert.ok(validate(fragment), JSON.stringify(validate.errors));
  assert.ok(validate(withoutRepo), JSON.stringify(validate.errors));
  assert.ok(validate({ ...withoutRepo, repo: { ship: "merge" } }));
});

test("repo: rejects ship: tag without release_tag, unknown keys and unknown ship values", () => {
  assert.equal(validate({ ...withoutRepo, repo: { ship: "tag" } }), false);
  assert.equal(validate({ ...withoutRepo, repo: { shipp: "tag" } }), false);
  assert.equal(validate({ ...withoutRepo, repo: { ship: "deploy" } }), false);
});
