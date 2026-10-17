import { describe, expect, it, vi } from "vitest";

const typed = ["o/r#5", ""];
vi.mock("node:readline/promises", () => ({
  createInterface: () => ({
    on: () => {},
    close: () => {},
    question: async () => typed.shift() ?? "",
  }),
}));

const { runFormWizard } = await import("../wizard.js");

const bundle = {
  schema: {
    type: "object",
    properties: {
      issue_id: { type: "string", title: "Issue" },
      task: { type: "string", title: "Task" },
    },
  },
  uiSchema: { "ui:order": ["issue_id", "task"] },
  formData: {},
};

describe("runFormWizard afterField", () => {
  it("afterField answers become later fields' defaults", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const out = await runFormWizard(
      bundle,
      {},
      {
        afterField: async (k): Promise<Record<string, string>> =>
          k === "issue_id" ? { task: "From issue" } : {},
      },
    );
    expect(out).toEqual({ issue_id: "o/r#5", task: "From issue" });
  });
});
