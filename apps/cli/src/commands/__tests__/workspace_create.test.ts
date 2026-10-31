import * as path from "node:path";
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
let wizardServices = "api";
let reasked: string[] = [];
let specOpts: unknown = null;
let refProject: string | null = null;
const fetched: string[] = [];

class FakeWorkspaceError extends Error {}
class FakeInitError extends Error {}
vi.mock("werkmeister-core", () => ({
  createWorkspace: async (...a: unknown[]) => {
    calls.push(a);
    if (createError) throw createError;
    return { workspacePath: "/ws/x" };
  },
  distillIssue: async () => ({ fields: { description: "d" }, warning: null }),
  WorkspaceError: FakeWorkspaceError,
}));
vi.mock("werkmeister-core/workspace_prompts", () => ({
  resolveInputs: (a: Record<string, unknown>) => ({
    ...(a.feature ? { feature: a.feature } : {}),
    ...(a.issue_id ? { issue_id: a.issue_id } : {}),
    ...presetInputs,
  }),
  workspacePromptSpec: (_b: string, _r: unknown, o: unknown) => {
    specOpts = o;
    return {};
  },
}));
vi.mock("werkmeister-core/workspace_init", () => ({ WorkspaceInitError: FakeInitError }));
vi.mock("werkmeister-core/issue_snapshot", () => ({
  fetchIssueSnapshot: async (ref: string) => {
    fetched.push(ref);
    if (fetchError) throw fetchError;
    return { title: "t" };
  },
}));
vi.mock("werkmeister-core/issue_tracker", () => ({
  issueTracker: () => ({
    label: "GitHub",
    refExample: "o/r#1",
    parseRef: (r: string) => (/^o\/r#\d+$/.test(r) ? r : /^\d+$/.test(r) ? `o/r#${r}` : null),
  }),
  projectFor: () => (refProject ? { name: refProject } : null),
}));
vi.mock("werkmeister-core/form_schema", async () => ({
  buildFormSchema: () => ({}),
  repoSelectionError: (
    await vi.importActual<typeof import("werkmeister-core/form_schema")>(
      "werkmeister-core/form_schema",
    )
  ).repoSelectionError,
}));
let wsRoot = "/ws-root";
vi.mock("werkmeister-core/config", () => ({ workspacesRoot: () => wsRoot }));
vi.mock("werkmeister-core/proc", () => ({ run: () => ({ status: 0 }) }));
vi.mock("../../lib/config.js", () => ({
  error: (m: string) => errors.push(m),
  warn: (m: string) => warns.push(m),
  info: () => {},
  getMonorepoRoot: () => "/",
}));
vi.mock("../../lib/wizard.js", () => ({
  runFormWizard: async (
    _b: unknown,
    r: Record<string, string>,
    o: { afterField: (k: string, r: Record<string, string>) => Promise<unknown> },
  ) => {
    Object.assign(r, wizardServices ? { services: wizardServices } : {}, wizardResolved);
    for (const k of wizardKeys) afterFieldResults.push(await o.afterField(k, r));
    return r;
  },
  fieldsOf: () => [{ key: "services" }, { key: "repos" }],
  askField: async (f: { key: string }, r: Record<string, string>) => {
    const v = reasked.shift() ?? "";
    if (v) r[f.key] = v;
  },
}));
vi.mock("../init_workspace.js", () => ({ readStdinTask: async () => "" }));

const { run, browserFormCommand } = await import("../workspace.js");

const tty = (v: boolean) =>
  Object.defineProperty(process.stdin, "isTTY", { value: v, configurable: true });

describe("sandbox workspace", () => {
  beforeEach(() => {
    calls.length = errors.length = warns.length = fetched.length = 0;
    createError = fetchError = null;
    refProject = null;
    wizardKeys = [];
    wizardResolved = {};
    afterFieldResults = [];
    presetInputs = {};
    wizardServices = "api";
    reasked = [];
    specOpts = null;
    tty(false);
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new Error(`exit:${c}`);
    }) as never);
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
    const cmd = browserFormCommand("node", "form-cli.js", {
      feature: "f",
      services: "cli",
      issue_id: "o/r#5",
      open_vscode: true,
      browser_form: true,
    });
    expect(cmd.slice(0, 2)).toEqual(["node", "form-cli.js"]);
    expect(cmd).toContain("--open");
    expect(cmd[cmd.indexOf("--issue") + 1]).toBe("o/r#5");
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({
      feature: "f",
      services: ["cli"],
      issue_id: "o/r#5",
    });
  });

  it("--browser-form splits comma-separated multi fields into the form's arrays", () => {
    const cmd = browserFormCommand("node", "form-cli.js", {
      services: "cli, api",
      repos: "a,b",
      labels: "x,y",
    });
    expect(JSON.parse(cmd[cmd.indexOf("--prefill") + 1])).toEqual({
      services: ["cli", "api"],
      repos: ["a", "b"],
      labels: "x,y",
    });
  });

  describe("wizard repo rule and cwd defaults (SW-51)", () => {
    beforeEach(() => {
      tty(true);
      wizardServices = "";
    });

    it("warns with repoSelectionError and re-asks services and repos until one is picked", async () => {
      reasked = ["", "", "", "web"]; // services, repos (still none), services, repos
      await run({ feature: "f" });
      expect(warns).toEqual([
        "Select at least one service (or add a repo below) — a workspace needs at least one repo.",
        "Select at least one service (or add a repo below) — a workspace needs at least one repo.",
      ]);
      expect((calls[0] as [Record<string, string>])[0]).toMatchObject({ repos: "web" });
    });

    it("derives no defaults from a cwd outside the workspaces root (~ in VS Code)", async () => {
      reasked = ["api"];
      await run({ feature: "f" });
      expect(specOpts).toEqual({ defaults: false });
    });

    it("keeps them in a workspace dir under the root", async () => {
      wsRoot = path.dirname(process.cwd());
      reasked = ["api"];
      await run({ feature: "f" });
      wsRoot = "/ws-root";
      expect(specOpts).toEqual({ defaults: true });
    });
  });

  describe("wizard issue step", () => {
    beforeEach(() => {
      tty(true);
      wizardKeys = ["issue_id"];
    });

    it("normalises the typed ref, reads it once, and hands the snapshot to createWorkspace", async () => {
      wizardResolved = { issue_id: "5" };
      await run({ feature: "f" });
      expect(fetched).toEqual(["o/r#5"]);
      expect(afterFieldResults[0]).toEqual({ task: "t", description: "d" });
      const [formData, opts] = calls[0] as [Record<string, string>, Record<string, unknown>];
      expect(formData.issue_id).toBe("o/r#5");
      expect(opts).toMatchObject({ issue: { title: "t" }, distill: false });
    });

    it("defaults the next prompt, project, to the project whose scope holds the ref (SW-104)", async () => {
      wizardResolved = { issue_id: "5" };
      refProject = "acme";
      await run({ feature: "f" });
      expect(afterFieldResults[0]).toEqual({ task: "t", description: "d", project: "acme" });
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
      expect(errors).toEqual([
        "couldn't read o/r#5 from GitHub; run `werkmeister infra connect` to check the issue tracker.",
      ]);
      expect(calls).toEqual([]);
    });
  });
});
