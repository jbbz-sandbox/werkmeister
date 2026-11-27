import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// SW-1085: `issue start [ref] [--attach]`. The tracker move is a stub; --attach writes a real temp workspace.yml.
const s = vi.hoisted(() => ({
  ws: "",
  started: [] as Array<string[] | undefined>,
  said: [] as string[],
  warned: [] as string[],
}));
vi.mock("../../lib/config.js", () => ({
  error: () => {},
  success: (m: string) => s.said.push(m),
  warn: (m: string) => s.warned.push(m),
}));
vi.mock("../../lib/cli_currency.js", () => ({
  checkCliCurrent: () => ({ current: true, text: "current" }),
}));
vi.mock("werkmeister-core/gate", async (real) => ({
  ...(await real<object>()),
  findWorkspaceRoot: () => s.ws,
}));
vi.mock("werkmeister-core/global_config", async (real) => ({
  ...(await real<object>()),
  candidateWorkspaceRoots: () => [],
}));
vi.mock("werkmeister-core/worktrees", async (real) => ({
  ...(await real<object>()),
  listRepoWorktrees: async () => [],
  syncToBase: () => [],
}));
vi.mock("werkmeister-core/issue_status", async (real) => ({
  ...(await real<object>()),
  startIssue: async (_ws: string, _t: unknown, _s: unknown, only?: string[]) => {
    s.started.push(only);
    return only ? `${only[0]} → In Progress` : "no issue";
  },
}));
vi.mock("werkmeister-core/issue_tracker", async (real) => ({
  ...(await real<object>()),
  defaultProject: () => null,
  issueIdOf: () => "",
  projectOf: () => "",
  trackerById: () => ({}),
  issueBriefing: () => "",
  issueTracker: () => ({
    parseRef: (t: string) => /[A-Za-z][A-Za-z0-9]+-\d+/.exec(t)?.[0].toUpperCase() ?? null,
  }),
}));
const { run } = await import("../issue.js");

beforeEach(() => {
  s.ws = fs.mkdtempSync(path.join(os.tmpdir(), "issue-start-"));
  fs.mkdirSync(path.join(s.ws, ".werkmeister"));
  fs.writeFileSync(path.join(s.ws, ".werkmeister", "workspace.yml"), "feature: demo\n");
  fs.mkdirSync(path.join(s.ws, "stages", "01_reproduce"), { recursive: true });
  fs.writeFileSync(path.join(s.ws, "stages", "01_reproduce", "CONTEXT.md"), "# contract\n");
  Object.assign(s, { started: [], said: [], warned: [] });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(s.ws, { recursive: true, force: true });
});

const start = (ref: string | null, attach = false) => run({ action: "start", ref, attach });

it("starts the ref it is given", async () => {
  await start("sw-1071");
  expect(s.started).toEqual([["SW-1071"]]);
  expect(s.said).toContain("Issue: SW-1071 → In Progress");
});

it("warns, not ok, when there is no ref and no workspace issue", async () => {
  await start(null);
  expect(s.warned).toContain("Issue: no issue");
  expect(s.said.some((m) => m.startsWith("Issue:"))).toBe(false);
});

it("--attach records the key in workspace.yml and leaves stages/ byte-identical", async () => {
  const contract = path.join(s.ws, "stages", "01_reproduce", "CONTEXT.md");
  const before = fs.readFileSync(contract);
  await start("SW-1071", true);
  const yml = fs.readFileSync(path.join(s.ws, ".werkmeister", "workspace.yml"), "utf8");
  expect(yml).toMatch(/^issue_id: SW-1071$/m);
  expect(yml).toMatch(/^feature: demo$/m);
  expect(fs.readFileSync(contract).equals(before)).toBe(true);
  // The attached key is now the workspace's own, so the move reads it from workspace.yml.
  expect(s.started).toEqual([undefined]);
});
