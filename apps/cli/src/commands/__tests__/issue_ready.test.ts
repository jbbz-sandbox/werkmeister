import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The projects, the workspace around CWD and the tracker are stubs: no config file, no network.
const s = vi.hoisted(() => ({
  projects: [] as Array<{ name: string; board?: { id: string; ready: string } }>,
  workspace: null as string | null,
  wsProject: "",
  asked: [] as Array<{ project?: string; board?: unknown }>,
  errors: [] as string[],
}));
vi.mock("../../lib/config.js", () => ({
  error: (m: string) => s.errors.push(m),
  success: () => {},
  warn: () => {},
}));
vi.mock("werkmeister-core/projects", () => ({ loadProjects: () => s.projects }));
vi.mock("werkmeister-core/gate", () => ({ findWorkspaceRoot: () => s.workspace }));
vi.mock("werkmeister-core/global_config", () => ({ candidateWorkspaceRoots: () => [] }));
vi.mock("werkmeister-core/workspace_prompts", () => ({ loadConfigFile: () => ({}) }));
vi.mock("werkmeister-core/issue_status", () => ({ startIssue: async () => "" }));
vi.mock("werkmeister-core/issue_tracker", () => ({
  defaultProject: () => null,
  issueIdOf: () => "",
  projectOf: () => s.wsProject,
  trackerById: () => ({}),
  issueBriefing: () => "",
  issueTracker: (at: { project?: string }) => ({
    listReady: async (board?: unknown) => {
      s.asked.push({ project: at.project, board });
      return [{ ref: "acme/web#9", status: "Ready", title: "nine" }];
    },
  }),
}));
const { run } = await import("../issue.js");

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  Object.assign(s, { projects: [], workspace: null, wsProject: "", asked: [], errors: [] });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const board = { id: "3", ready: "Ready" };

it("--json prints the project's ready list, read from its board", async () => {
  s.projects = [{ name: "acme", board }, { name: "werkmeister" }];
  await run({ action: "ready", project: "acme", json: true });
  expect(s.asked).toEqual([{ project: "acme", board }]);
  expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual([
    { ref: "acme/web#9", status: "Ready", title: "nine" },
  ]);
});

it("no projects: exit 1 naming where to add one", async () => {
  await expect(run({ action: "ready", json: true })).rejects.toThrow("exit 1");
  expect(s.errors.join("\n")).toMatch(
    /no project: add one under projects: in ~\/\.werkmeister\/config\.yaml/,
  );
});

it("inside a workspace, the project defaults to the workspace's", async () => {
  s.projects = [{ name: "acme", board }, { name: "werkmeister" }];
  s.workspace = "/ws";
  s.wsProject = "werkmeister";
  await run({ action: "ready", project: null });
  expect(s.asked).toEqual([{ project: "werkmeister", board: undefined }]);
  expect(log.mock.calls.map((c) => c[0])).toEqual(["acme/web#9  Ready  nine"]);
});

it("several projects and none picked: exit 1 listing them", async () => {
  s.projects = [{ name: "acme" }, { name: "werkmeister" }];
  await expect(run({ action: "ready" })).rejects.toThrow("exit 1");
  expect(s.errors.join("\n")).toMatch(/pass --project \(one of: acme, werkmeister\)/);
});
