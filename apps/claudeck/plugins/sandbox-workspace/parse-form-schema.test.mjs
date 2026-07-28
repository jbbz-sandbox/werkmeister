import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaToFields } from "./parse-form-schema.mjs";

const BUNDLE = {
  schema: {
    type: "object",
    properties: {
      jira_id: { title: "Jira ID", type: "string", pattern: "^$|X" },
      feature: { title: "Feature", type: "string", pattern: "^[a-z]+$", minLength: 1 },
      work_type: { title: "Work type", type: "string", enum: ["feature", "bugfix"] },
      services: { title: "Services", type: "array", items: { type: "string", enum: ["a", "b"] } },
      starting_prompt: { title: "Prompt", type: "string" },
    },
    required: ["feature", "work_type"],
  },
  uiSchema: {
    jira_id: { "ui:placeholder": "TRE-1234" },
    services: { "ui:widget": "checkboxes" },
    starting_prompt: {
      "ui:widget": "textarea",
      "ui:options": { refinable: true, refineInstruction: "Rewrite it." },
    },
    "ui:order": ["jira_id", "feature", "work_type", "services", "starting_prompt"],
  },
  formData: {},
  title: "Initialize x",
};

test("maps widgets, required, pattern, placeholder", () => {
  const f = schemaToFields(BUNDLE);
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.equal(by.feature.widget, "text");
  assert.equal(by.feature.required, true);
  assert.equal(by.feature.pattern, "^[a-z]+$");
  assert.equal(by.jira_id.placeholder, "TRE-1234");
  assert.equal(by.jira_id.required, false);
  assert.equal(by.work_type.widget, "select");
  assert.deepEqual(by.work_type.enumOptions, ["feature", "bugfix"]);
  assert.equal(by.services.widget, "checkboxes");
  assert.deepEqual(by.services.enumOptions, ["a", "b"]);
  assert.equal(by.starting_prompt.widget, "textarea");
  assert.equal(by.starting_prompt.refinable, true);
  assert.equal(by.starting_prompt.refineInstruction, "Rewrite it.");
});

test("respects ui:order", () => {
  const keys = schemaToFields(BUNDLE).map((x) => x.key);
  assert.deepEqual(keys, ["jira_id", "feature", "work_type", "services", "starting_prompt"]);
});

test("appends keys missing from ui:order, in schema order", () => {
  const b = structuredClone(BUNDLE);
  b.uiSchema["ui:order"] = ["feature"];
  assert.deepEqual(schemaToFields(b).map((x) => x.key), [
    "feature", "jira_id", "work_type", "services", "starting_prompt",
  ]);
});
