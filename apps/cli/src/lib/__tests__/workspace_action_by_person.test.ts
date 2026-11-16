/**
 * SW-833: the workspaces pane runs runWorkspaceAction in a child of Claude Code, which inherits
 * CLAUDECODE=1, so its Up read as an agent's and never preempted. The pane says it is a person's.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ root: "" }));

vi.mock("werkmeister-core/lifecycle", () => ({
  up: vi.fn(async (feature: string) => ({ feature, urls: [] })),
}));
vi.mock("werkmeister-core/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("werkmeister-core/config")>()),
  workspacesRoot: () => h.root,
}));

import { runWorkspaceAction } from "werkmeister-core";
import { up } from "werkmeister-core/lifecycle";

beforeEach(() => {
  vi.mocked(up).mockClear();
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-action-"));
  fs.mkdirSync(path.join(h.root, "ws"));
  fs.writeFileSync(path.join(h.root, "ws", ".env"), "FEATURE=demo\n");
});
afterEach(() => fs.rmSync(h.root, { recursive: true, force: true }));

it("an up the caller marks as a person's starts as a person's, whatever the environment says", async () => {
  await runWorkspaceAction("ws", "up", { byPerson: true });
  expect(vi.mocked(up).mock.calls[0]?.[2]).toEqual({ byPerson: true });
});

it("a person's up in an autonomous workspace still starts as an agent's", async () => {
  fs.mkdirSync(path.join(h.root, "ws", ".werkmeister"));
  fs.writeFileSync(path.join(h.root, "ws", ".werkmeister", "workspace.yml"), "autonomous: true\n");
  await runWorkspaceAction("ws", "up", { byPerson: true });
  expect(vi.mocked(up).mock.calls[0]?.[2]).toEqual({ byPerson: false });
});

it("an unmarked up leaves the choice to up's default", async () => {
  await runWorkspaceAction("ws", "up");
  expect(vi.mocked(up).mock.calls[0]?.[2]?.byPerson).toBeUndefined();
});
