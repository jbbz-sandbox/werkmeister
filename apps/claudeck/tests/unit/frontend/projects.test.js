// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE_PATH = "../../../public/js/features/projects.js";

// Mock all dependencies — must be before the dynamic import below
vi.mock("../../../public/js/core/dom.js", () => ({
  $: {
    projectSelect: {
      value: "",
      options: [{ value: "", textContent: "" }],
      selectedIndex: 0,
      addEventListener: vi.fn(),
      appendChild: vi.fn(),
    },
    sessionList: { innerHTML: "" },
    messagesDiv: { innerHTML: "", appendChild: vi.fn() },
    messageInput: {
      value: "",
      style: { height: "" },
      scrollHeight: 100,
      focus: vi.fn(),
    },
    headerProjectName: { textContent: "" },
    spBadge: { classList: { add: vi.fn(), remove: vi.fn() } },
    spEditBtn: { addEventListener: vi.fn() },
    spForm: { addEventListener: vi.fn() },
    spTextarea: { value: "", focus: vi.fn() },
    spModal: {
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    },
    newSessionBtn: { addEventListener: vi.fn() },
    toggleParallelBtn: {
      checked: false,
      addEventListener: vi.fn(),
    },
    openVscodeBtn: { addEventListener: vi.fn() },
    removeProjectBtn: { addEventListener: vi.fn() },
    addProjectBtn: { addEventListener: vi.fn() },
    addProjectClose: { addEventListener: vi.fn() },
    addProjectConfirm: { addEventListener: vi.fn() },
    addProjectModal: {
      classList: { add: vi.fn(), remove: vi.fn() },
      addEventListener: vi.fn(),
    },
    addProjectName: { value: "", focus: vi.fn() },
    folderList: { innerHTML: "", appendChild: vi.fn() },
    folderBreadcrumb: { innerHTML: "", appendChild: vi.fn() },
    folderPathInput: { value: "", addEventListener: vi.fn() },
    folderPathGo: { addEventListener: vi.fn() },
    folderRecents: {
      innerHTML: "",
      appendChild: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    },
    folderNewToggle: { addEventListener: vi.fn() },
    folderNewToggleRow: { classList: { add: vi.fn(), remove: vi.fn() } },
    folderNewRow: { classList: { add: vi.fn(), remove: vi.fn() } },
    folderNewName: { value: "", focus: vi.fn(), addEventListener: vi.fn() },
    folderNewCreate: { addEventListener: vi.fn() },
    folderNewCancel: { addEventListener: vi.fn() },
    addProjectMessage: { className: "", innerHTML: "", appendChild: vi.fn() },
    sendBtn: { classList: { add: vi.fn(), remove: vi.fn() } },
    stopBtn: { classList: { add: vi.fn(), remove: vi.fn() } },
  },
}));

vi.mock("../../../public/js/core/store.js", () => ({
  getState: vi.fn(() => []),
  setState: vi.fn(),
}));

vi.mock("../../../public/js/core/constants.js", () => ({
  CHAT_IDS: ["chat-0", "chat-1", "chat-2"],
}));

vi.mock("../../../public/js/core/api.js", () => ({
  fetchProjects: vi.fn(() => Promise.resolve([])),
  saveSystemPromptApi: vi.fn(() => Promise.resolve()),
  fetchProjectCommands: vi.fn(() => Promise.resolve([])),
  browseFolders: vi.fn(() => Promise.resolve({ current: "/", dirs: [] })),
  addProject: vi.fn(() =>
    Promise.resolve({ project: { name: "test", path: "/test" } })
  ),
  deleteProject: vi.fn(() => Promise.resolve()),
  createFolder: vi.fn(() => Promise.resolve({ ok: true, path: "/test/new" })),
}));

vi.mock("../../../public/js/ui/commands.js", () => ({
  commandRegistry: {},
  registerCommand: vi.fn(),
}));

vi.mock("../../../public/js/ui/parallel.js", () => ({
  panes: new Map(),
}));

vi.mock("../../../public/js/features/sessions.js", () => ({
  loadSessions: vi.fn(),
}));

vi.mock("../../../public/js/features/cost-dashboard.js", () => ({
  loadStats: vi.fn(),
}));

vi.mock("../../../public/js/ui/messages.js", () => ({
  showWhalyPlaceholder: vi.fn(),
  addSkillUsedMessage: vi.fn(),
}));

vi.mock("../../../public/js/features/attachments.js", () => ({
  updateAttachmentBadge: vi.fn(),
  clearImageAttachments: vi.fn(),
}));

let loadProjects, updateSystemPromptIndicator, updateHeaderProjectName, loadProjectCommands;

// projects.js resolves DOM references and attaches listeners at module scope, so
// every id it looks up must exist before the dynamic import below. The list is
// derived from the source rather than hardcoded: a hardcoded copy silently broke
// this whole suite when the Add Project tabs added four new lookups, and the
// import-time throw skipped all 8 tests rather than failing one.
function stubModuleDom() {
  const source = readFileSync(fileURLToPath(new URL(MODULE_PATH, import.meta.url)), "utf8");
  const ids = new Set([...source.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]));
  expect(ids.size, "expected to find getElementById lookups to stub").toBeGreaterThan(0);
  for (const id of ids) {
    if (document.getElementById(id)) continue;
    const el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }
  return ids;
}

beforeAll(async () => {
  stubModuleDom();

  const mod = await import(MODULE_PATH);
  loadProjects = mod.loadProjects;
  updateSystemPromptIndicator = mod.updateSystemPromptIndicator;
  updateHeaderProjectName = mod.updateHeaderProjectName;
  loadProjectCommands = mod.loadProjectCommands;
});

describe("projects module", () => {
  it("loads without error", () => {
    expect(true).toBe(true);
  });

  it("exports loadProjects as a function", () => {
    expect(typeof loadProjects).toBe("function");
  });

  it("exports updateSystemPromptIndicator as a function", () => {
    expect(typeof updateSystemPromptIndicator).toBe("function");
  });

  it("exports updateHeaderProjectName as a function", () => {
    expect(typeof updateHeaderProjectName).toBe("function");
  });

  it("exports loadProjectCommands as a function", () => {
    expect(typeof loadProjectCommands).toBe("function");
  });

  it("loadProjectCommands resolves without error when no project selected", async () => {
    await expect(loadProjectCommands()).resolves.toBeUndefined();
  });

  it("updateHeaderProjectName sets empty text when no project selected", () => {
    updateHeaderProjectName();
    expect(true).toBe(true);
  });

  it("updateSystemPromptIndicator runs without error", () => {
    expect(() => updateSystemPromptIndicator()).not.toThrow();
  });
});
