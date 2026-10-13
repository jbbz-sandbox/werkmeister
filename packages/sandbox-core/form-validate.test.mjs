// The /workspaces pane validates with these instead of AJV, and both create forms merge issue fields with them.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFormSchema, mergeFormData, repoSelectionError, validateFormData } from "./dist/form_schema.js";

const bundle = buildFormSchema({
  prompts: [
    { key: "issue_id", label: "Issue", pattern: "^[A-Z][A-Z0-9]+-[0-9]+$" },
    { key: "feature", label: "Feature", accept_empty: false, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
    { key: "work_type", label: "Work type", accept_empty: false, choices: ["feature", "bugfix"] },
    { key: "services", label: "Services", multi: true, choices: ["api", "web"] },
  ],
});

test("valid data has no errors", () => {
  assert.deepEqual(validateFormData(bundle, { feature: "mdx-blog", work_type: "bugfix", services: ["api"] }), {});
});

test("required, pattern, choices and the repo rule each report under their field", () => {
  assert.deepEqual(validateFormData(bundle, { issue_id: "proj-1", work_type: "chore", services: [] }), {
    issue_id: "\"proj-1\" doesn't match the expected format",
    feature: "required",
    work_type: "not offered: chore",
    services: repoSelectionError({}),
  });
});

test("an optional pattern field may be blank, and repos alone satisfy the repo rule", () => {
  assert.deepEqual(validateFormData(bundle, { feature: "x", work_type: "bugfix", issue_id: "", repos: ["r"] }), {});
});

test("mergeFormData fills only blanks, but always takes the canonical issue_id", () => {
  assert.deepEqual(
    mergeFormData({ issue_id: "api#7", task: "mine", services: [] }, { issue_id: "acme/api#7", task: "theirs", services: ["api"], description: "" }),
    { issue_id: "acme/api#7", task: "mine", services: ["api"] },
  );
});
