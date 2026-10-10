/** buildFormSchema (RJSF bundle). */
import { describe, expect, it } from "vitest";

import { buildFormSchema } from "sandbox-core/form_schema";

function spec(prompts: Record<string, any>[], name = "demo"): Record<string, any> {
  return { workspace_name: name, workspace_root: `/ws/${name}`, prompts };
}

describe("buildFormSchema", () => {
  it("required, recommended, and pattern", () => {
    const out = buildFormSchema(
      spec([
        {
          key: "feature", label: "Feature", help: "h", accept_empty: false,
          multi: false, recommended: true, pattern: "^[a-z-]+$",
          placeholder: "mdx-blog", default: "my-feat", resolved: false,
        },
      ]),
    );
    const prop = out.schema.properties.feature;
    expect(out.schema.required).toEqual(["feature"]);
    expect(prop.type).toBe("string");
    expect(prop.minLength).toBe(1);
    expect(prop.pattern).toBe("^[a-z-]+$"); // required → pattern as-is
    expect(out.uiSchema.feature["ui:placeholder"]).toBe("mdx-blog");
    expect(out.uiSchema.feature["ui:autofocus"]).toBe(true); // first field
    expect(out.formData.feature).toBe("my-feat");
  });

  it("optional pattern allows empty", () => {
    const out = buildFormSchema(
      spec([
        { key: "feature", accept_empty: false, recommended: true, default: "f" },
        {
          key: "issue_id", label: "Issue", accept_empty: true,
          pattern: "^[A-Z]+-[0-9]+$", default: "", resolved: false,
        },
      ]),
    );
    const issue = out.schema.properties.issue_id;
    expect(issue.pattern).toBe("^$|(?:^[A-Z]+-[0-9]+$)"); // optional → empty OR-ed in
    expect(out.schema.required ?? []).not.toContain("issue_id");
  });

  it("multi choices become array with checkboxes", () => {
    const out = buildFormSchema(
      spec([
        {
          key: "services", label: "Services", multi: true,
          choices: ["backend", "frontend"], default: "frontend",
          resolved: false,
        },
      ]),
    );
    const prop = out.schema.properties.services;
    expect(prop.type).toBe("array");
    expect(prop.uniqueItems).toBe(true);
    expect(prop.items.enum).toEqual(["backend", "frontend"]);
    expect(out.uiSchema.services["ui:widget"]).toBe("checkboxes");
    expect(out.formData.services).toEqual(["frontend"]); // comma split → list
  });

  it("multi without choices becomes plain string", () => {
    const out = buildFormSchema(
      spec([
        { key: "labels", label: "Labels", multi: true, default: "one,two", resolved: false },
      ]),
    );
    const prop = out.schema.properties.labels;
    expect(prop.type).toBe("string");
    expect(!("labels" in out.uiSchema) || out.uiSchema.labels["ui:widget"] !== "checkboxes").toBe(true);
    expect(out.formData.labels).toBe("one,two");
  });

  it("multiline string becomes textarea", () => {
    const out = buildFormSchema(
      spec([
        { key: "starting_prompt", label: "Starting prompt", multiline: true, accept_empty: true, resolved: false },
      ]),
    );
    const prop = out.schema.properties.starting_prompt;
    expect(prop.type).toBe("string");
    expect("enum" in prop).toBe(false);
    expect(out.uiSchema.starting_prompt["ui:widget"]).toBe("textarea");
    expect(out.schema.required ?? []).not.toContain("starting_prompt");
  });

  it("refinable multiline keeps standard textarea with options", () => {
    const out = buildFormSchema(
      spec([
        {
          key: "starting_prompt", label: "Starting prompt", multiline: true,
          refinable: true, refine_instruction: "Rewrite as a dev instruction.",
          accept_empty: true, resolved: false,
        },
      ]),
    );
    const ui = out.uiSchema.starting_prompt;
    expect(ui["ui:widget"]).toBe("textarea");
    expect(ui["ui:options"]).toEqual({
      refinable: true, refineInstruction: "Rewrite as a dev instruction.",
    });
  });

  it("multiline without refinable stays plain textarea", () => {
    const out = buildFormSchema(
      spec([
        { key: "notes", label: "Notes", multiline: true, accept_empty: true, resolved: false },
      ]),
    );
    expect(out.uiSchema.notes["ui:widget"]).toBe("textarea");
    expect("ui:options" in out.uiSchema.notes).toBe(false);
  });

  it("single choice becomes enum dropdown", () => {
    const out = buildFormSchema(
      spec([
        { key: "env", label: "Env", choices: ["dev", "stage"], default: "dev", resolved: false },
      ]),
    );
    const prop = out.schema.properties.env;
    expect(prop.enum).toEqual(["dev", "stage"]);
    expect("pattern" in prop).toBe(false);
    expect(out.formData.env).toBe("dev");
  });

  it("resolved prompts are omitted", () => {
    const out = buildFormSchema(
      spec([
        { key: "feature", accept_empty: false, recommended: true, default: "f" },
        { key: "task", label: "Task", resolved: true, resolved_value: "Already set" },
      ]),
    );
    expect("task" in out.schema.properties).toBe(false);
    expect(out.uiSchema["ui:order"] ?? []).not.toContain("task");
    expect(out.uiSchema["ui:order"]).toEqual(["feature"]);
  });

  it("title default and override", () => {
    const s = spec([{ key: "x", default: "" }], "my-ws");
    expect(buildFormSchema(s).title).toBe("Initialize my-ws");
    expect(buildFormSchema(s, "Custom").schema.title).toBe("Custom");
  });
});
