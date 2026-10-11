import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
const errors: string[] = [];
const warns: string[] = [];
let createError: Error | null = null;
let fetchError: Error | null = null;
let wizardKeys: string[] = [];
let wizardResolved: Record<string, string> = {};
let afterFieldResults: unknown[] = [];
let presetInputs: Record<string, string> = {};
const fetched: string[] = [];

class FakeWorkspaceError extends Error {}
class FakeInitError extends Error {}
vi.mock("sandbox-core", () => ({
  createWorkspace: async (...a: unknown[]) => { calls.push(a); if (createError) throw createError; return { workspacePath: "/ws/x" }; },
  distillIssue: async () => ({ fields: { description: "d" }, warning: null }),
  WorkspaceError: FakeWorkspaceError,
}));
vi.mock("sandbox-core/workspace_prompts", () => ({ resolveInputs: (a: Record<string, unknown>) => ({ ...(a.feature ? { feature: a.feature } : {}), ...(a.issue_id ? { issue_id: a.issue_id } : {}), ...presetInputs }), workspacePromptSpec: () => ({}) }));
vi.mock("sandbox-core/workspace_init", () => ({ WorkspaceInitError: FakeInitError }));
vi.mock("sandbox-core/issue_snapshot", () => ({ fetchIssueSnapshot: async (ref: string) => { fetched.push(ref); if (fetchError) throw fetchError; return { title: "t" }; } }));
vi.mock("sandbox-core/issue_tracker", () => ({
  issueTracker: () => ({ label: "GitHub", refExample: "o/r#1", parseRef: (r: string) => (/^o\/r#\d+$/.test(r) ? r : /^\d+$/.test(r) ? `o/r#${r}` : null) }),
}));
vi.mock("sandbox-core/form_schema", () => ({ buildFormSchema: () => ({}) }));
vi.mock("sandbox-core/proc", () => ({ run: () => ({ status: 0 }) }));
vi.mock("../../lib/config.js", () => ({
  error: (m: string) => errors.push(m), warn: (m: string) => warns.push(m), info: () => {}, getMonorepoRoot: () => "/",
}));
vi.mock("../../lib/wizard.js", () => ({
  runFormWizard: async (_b: unknown, r: Record<string, string>, o: { afterField: (k: string, r: Record<string, string>) => Promise<unknown> }) => {
    Object.assign(r, wizardResolved);
    for (const k of wizardKeys) afterFieldResults.push(await o.afterField(k, r));
    return r;
  },
}));
vi.mock("../init_workspace.js", () => ({ readStdinTask: async () => "" }));

const { run, browserFormCommand } = await import("../workspace.js");

const tty = (v: boolean) => Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });

describe("sandbox workspace", () => {
  beforeEach(() => {
    calls.length = errors.length = warns.length = fetched.length = 0;
    createError = fetchError = null;
    wizardKeys = []; wizardResolved = {}; afterFieldResults = []; presetInputs = {};
    tty(false);
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => { throw new Error(`exit:${c}`); }) as never);
  });

  it("creates through createWorkspace, live, from the cwd, with --no-distill honoured", async () => {
    await run({ feature: "f", issue_id: "o/r#5", no_distill: true });
    const [formData, opts] = calls[0] as [Record<string, string>, Record<string, unknown>];
    expect(formData).toMatchObject({ feature: "f", issue_id: "o/r#5" });
    expect(opts).toMatchObject({ live: true, open: false, cwd: process.cwd(), distill: false });
  });

  it("WorkspaceError prints once and exits 1", async () => {
    createError = new FakeWorkspaceError("boom");
    await expect(run({ feature: "f" })).rejects.toThrow("exit:1");
    expect(errors).toEqual(["boom"]);
  });

  it("WorkspaceInitError exits 1 without printing again", async () => {
    createError = new FakeInitError("already printed");
    await expect(run({ feature: "f" })).rejects.toThrow("exit:1");
    expect(errors).toEqual([]);
  });

  it("--browser-form forwards every given flag as --prefill JSON, and --issue", () => {
    const cmd = browserFormCommand("node", "form-cli.js", { feature: "f", services: "cli", issue_id: "o/r#5", open_vscode: true, browser_form: true });
    expect(cmd.slice(0, 2)).toEqual(["node", "form-cli.js"]);
    expect(cmd).toContain("--open");
    expect(cmd[cmd.indexOf("--issue") + 1]).toBe("o/r#5");
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({ feature: "f", services: ["cli"], issue_id: "o/r#5" });
  });

  it("--browser-form splits comma-separated multi fields into the form's arrays", () => {
    const cmd = browserFormCommand("node", "form-cli.js", { services: "cli, api", repos: "a,b", labels: "x,y" });
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({ services: ["cli", "api"], repos: ["a", "b"], labels: "x,y" });
  });

  describe("wizard issue step", () => {
    beforeEach(() => { tty(true); wizardKeys = ["issue_id"]; });

    it("normalises the typed ref, reads it once, and hands the snapshot to createWorkspace", async () => {
      wizardResolved = { issue_id: "5" };
      await run({ feature: "f" });
      expect(fetched).toEqual(["o/r#5"]);
      expect(afterFieldResults[0]).toEqual({ task: "t", description: "d" });
      const [formData, opts] = calls[0] as [Record<string, string>, Record<string, unknown>];
      expect(formData.issue_id).toBe("o/r#5");
      expect(opts).toMatchObject({ issue: { title: "t" }, distill: false });
    });

    it("skips an issue_id that came from flag/env/config", async () => {
      presetInputs = { issue_id: "o/r#9" };
      wizardResolved = { issue_id: "o/r#9" };
      await run({ feature: "f" });
      expect(fetched).toEqual([]);
      expect(afterFieldResults).toEqual([{}]);
    });

    it("stops the wizard on an unparseable ref: printed once, exit 1, nothing created", async () => {
      wizardResolved = { issue_id: "nonsense" };
      await expect(run({ feature: "f" })).rejects.toThrow("exit:1");
      expect(errors).toEqual(["nonsense isn't a GitHub issue ref (e.g. o/r#1)"]);
      expect(fetched).toEqual([]);
      expect(calls).toEqual([]);
    });

    it("stops the wizard when the tracker fetch fails: printed once, exit 1, nothing created", async () => {
      wizardResolved = { issue_id: "o/r#5" };
      fetchError = new Error("401");
      await expect(run({ feature: "f" })).rejects.toThrow("exit:1");
      expect(errors).toEqual(["couldn't read o/r#5 from GitHub; run `sandbox connect` to check the issue tracker."]);
      expect(calls).toEqual([]);
    });
  });
});
