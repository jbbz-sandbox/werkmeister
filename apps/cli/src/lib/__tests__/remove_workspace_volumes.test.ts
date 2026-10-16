/**
 * Deleting a workspace (remove-workspace, close-out) must take its per-feature
 * Docker volumes with it, or every removed workspace strands its
 * `<feature>-node-modules` / `<feature>-tools` volumes. A plain `down` keeps
 * them for the next `up`. That `removeVolumes` becomes `--volumes` on the
 * compose argv is compose_down.test.ts's job.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ root: "" }));

vi.mock("sandbox-core/lifecycle", () => ({
  down: vi.fn(async (feature: string) => ({ feature, slot: 1 })),
  reloadProxy: vi.fn(),
  restart: vi.fn(),
  stop: vi.fn(),
  up: vi.fn(),
}));
vi.mock("sandbox-core/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sandbox-core/config")>()),
  workspacesRoot: () => h.root,
}));

import { removeWorkspace, runWorkspaceAction } from "sandbox-core";
import { down } from "sandbox-core/lifecycle";

beforeEach(() => {
  vi.mocked(down).mockClear();
  h.root = fs.mkdtempSync(path.join(os.tmpdir(), "rm-ws-"));
  fs.mkdirSync(path.join(h.root, "ws"));
  fs.writeFileSync(path.join(h.root, "ws", ".env"), "FEATURE=demo\n");
});
afterEach(() => fs.rmSync(h.root, { recursive: true, force: true }));

it("removing a workspace tears it down with its volumes", async () => {
  await removeWorkspace("ws", { closedOut: true });
  expect(down).toHaveBeenCalledWith("demo", { removeVolumes: true });
  expect(fs.existsSync(path.join(h.root, "ws"))).toBe(false);
});

it("a plain down keeps the volumes", async () => {
  await runWorkspaceAction("ws", "down");
  expect(down).toHaveBeenCalledTimes(1);
  expect(vi.mocked(down).mock.calls[0][1]?.removeVolumes).toBeFalsy();
});
