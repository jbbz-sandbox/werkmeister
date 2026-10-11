import { describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
vi.mock("sandbox-core", () => ({
  createWorkspace: async (...a: unknown[]) => { calls.push(a); return { workspacePath: "/ws/x" }; },
  distillIssue: async () => ({ fields: {}, warning: null }),
  WorkspaceError: class extends Error {},
}));
vi.mock("sandbox-core/workspace_prompts", () => ({ resolveInputs: (a: Record<string, unknown>) => ({ feature: a.feature, issue_id: a.issue_id }), workspacePromptSpec: () => ({}) }));
vi.mock("sandbox-core/workspace_init", () => ({ WorkspaceInitError: class extends Error {} }));
vi.mock("sandbox-core/issue_snapshot", () => ({ fetchIssueSnapshot: async () => ({ title: "t" }) }));
vi.mock("sandbox-core/form_schema", () => ({ buildFormSchema: () => ({}) }));
vi.mock("sandbox-core/proc", () => ({ run: () => ({ status: 0 }) }));
vi.mock("../../lib/wizard.js", () => ({ runFormWizard: async (_b: unknown, r: unknown) => r }));
vi.mock("../init_workspace.js", () => ({ readStdinTask: async () => "" }));

const { run, browserFormCommand } = await import("../workspace.js");

describe("sandbox workspace", () => {
  it("creates through createWorkspace, live, from the cwd, with --no-distill honoured", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    await run({ feature: "f", issue_id: "o/r#5", no_distill: true });
    const [formData, opts] = calls[0] as [Record<string, string>, Record<string, unknown>];
    expect(formData).toMatchObject({ feature: "f", issue_id: "o/r#5" });
    expect(opts).toMatchObject({ live: true, open: false, cwd: process.cwd(), distill: false });
  });

  it("--browser-form forwards every given flag as --prefill JSON", () => {
    const cmd = browserFormCommand("node", "form-cli.js", { feature: "f", services: "cli", issue_id: "o/r#5", open_vscode: true, browser_form: true });
    expect(cmd.slice(0, 2)).toEqual(["node", "form-cli.js"]);
    expect(cmd).toContain("--open");
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({ feature: "f", services: "cli", issue_id: "o/r#5" });
  });
});
