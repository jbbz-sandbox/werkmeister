// The create form's bundle (SW-51): the defaults that don't depend on the cwd are
// preselected on every GUI; the ones derived from $HOME are not.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// A temp HOME named like a user: its name must not become the feature or task.
process.env.HOME = mkdtempSync(path.join(tmpdir(), "jay-"));
process.env.SANDBOX_CONFIG_FILE = "/nonexistent/config.yaml";

const { getFormSchema } = await import("./dist/sandbox.js");

test("getFormSchema preselects work type and workflow, and nothing derived from $HOME", async () => {
  const { schema, formData } = await getFormSchema();
  assert.deepEqual(formData, {
    work_type: "feature",
    context_strategy: "icm",
    autonomous: false,
    auto_stop: false,
  });
  assert.ok(schema.required.includes("work_type"));
  assert.equal(schema.properties.context_strategy.title, "Workflow");
});
