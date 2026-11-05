import { afterEach, beforeEach, expect, it, vi } from "vitest";

// SW-432: `issue create --relates`. The tracker is a stub: no config file, no network.
const s = vi.hoisted(() => ({
  created: 0,
  links: [] as Array<[string, string[]]>,
  failLink: "",
  errors: [] as string[],
  said: [] as string[],
}));
vi.mock("../../lib/config.js", () => ({
  error: (m: string) => s.errors.push(m),
  success: (m: string) => s.said.push(m),
  warn: () => {},
}));
vi.mock("node:fs", async (orig) => ({
  ...(await orig<typeof import("node:fs")>()),
  readFileSync: () => "body",
}));
vi.mock("werkmeister-core/projects", () => ({ loadProjects: () => [] }));
vi.mock("werkmeister-core/gate", () => ({ findWorkspaceRoot: () => null }));
vi.mock("werkmeister-core/global_config", () => ({ candidateWorkspaceRoots: () => [] }));
vi.mock("werkmeister-core/workspace_prompts", () => ({ loadConfigFile: () => ({}) }));
vi.mock("werkmeister-core/issue_status", () => ({ startIssue: async () => "" }));
vi.mock("werkmeister-core/issue_tracker", () => ({
  defaultProject: () => null,
  issueIdOf: () => "",
  projectOf: () => "",
  trackerById: () => ({}),
  issueBriefing: () => "",
  issueTracker: () => ({
    label: "Jira",
    refExample: "PROJ-123",
    parseRef: (t: string) => (/^[A-Z]+-\d+$/i.test(t) ? t.toUpperCase() : null),
    createIssue: async () => {
      s.created++;
      return { ref: "SW-13", type: "Task", url: "https://x/browse/SW-13" };
    },
    linkIssues: async (ref: string, to: string[]) => {
      if (to.includes(s.failLink)) throw new Error("HTTP 404");
      s.links.push([ref, to]);
    },
  }),
}));
const { run } = await import("../issue.js");

let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  Object.assign(s, { created: 0, links: [], failLink: "", errors: [], said: [] });
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});
afterEach(() => vi.restoreAllMocks());

const create = (relates?: string[]) =>
  run({
    action: "create",
    project: "SW",
    type: "task",
    title: "t",
    bodyFile: "-",
    relates,
  });

it("links the new issue to each --relates key and prints each link", async () => {
  await create(["SW-292", "sw-263"]);
  expect(log).toHaveBeenCalledWith("https://x/browse/SW-13");
  expect(s.links).toEqual([
    ["SW-13", ["SW-292"]],
    ["SW-13", ["SW-263"]],
  ]);
  expect(s.said).toEqual([
    "Created SW-13 (Task).",
    "Linked SW-13 relates to SW-292.",
    "Linked SW-13 relates to SW-263.",
  ]);
});

it("a bad --relates key files nothing", async () => {
  await expect(create(["SW-292", "nope"])).rejects.toThrow("exit 1");
  expect(s.created).toBe(0);
  expect(s.errors.join("\n")).toMatch(/--relates 'nope' is not a Jira issue ID/);
});

it("a refused link still prints the new key, then exits 1 naming both", async () => {
  s.failLink = "SW-263";
  await expect(create(["SW-292", "SW-263"])).rejects.toThrow("exit 1");
  expect(log).toHaveBeenCalledWith("https://x/browse/SW-13");
  expect(s.links).toEqual([["SW-13", ["SW-292"]]]);
  expect(s.errors.join("\n")).toMatch(/Created SW-13, but could not link it to SW-263: HTTP 404/);
});

it("without --relates nothing is linked", async () => {
  await create();
  expect(s.created).toBe(1);
  expect(s.links).toEqual([]);
});
