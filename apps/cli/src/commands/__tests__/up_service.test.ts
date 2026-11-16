/**
 * `werkmeister feature up --service <name>` (SW-132) starts that one service
 * through the PR gate's `startService`, not the whole `up`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ws: "", own: null as string | null, inside: false }));

vi.mock("werkmeister-core/lifecycle", () => ({
  startService: vi.fn(),
  up: vi.fn(),
  reloadProxy: vi.fn(),
  refreshWorkspaceSettings: vi.fn(),
  insideOwnContainer: () => h.inside,
}));
vi.mock("werkmeister-core/gate", () => ({ findWorkspaceRoot: () => h.own }));
vi.mock("werkmeister-core/global_config", () => ({ candidateWorkspaceRoots: () => [] }));
vi.mock("../../lib/config.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/config.js")>()),
  resolveWorkspace: () => h.ws,
}));

import {
  refreshWorkspaceSettings,
  reloadProxy,
  startService,
  up,
} from "werkmeister-core/lifecycle";
import { run } from "../up.js";

let lines: string[];
beforeEach(() => {
  h.ws = fs.mkdtempSync(path.join(os.tmpdir(), "up-service-"));
  h.own = h.ws;
  h.inside = false;
  vi.mocked(refreshWorkspaceSettings).mockClear();
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(h.ws, { recursive: true, force: true });
});

it("starts only the named service in the feature's workspace", async () => {
  await run({ feature: "f", workspace: null, dev: false, service: "docs-site" });
  // SW-701: a CLI --service start parks on timeout; the gate's does not.
  expect(startService).toHaveBeenCalledWith("f", h.ws, "docs-site", undefined, { park: true });
  expect(up).not.toHaveBeenCalled();
  expect(lines.join("\n")).toContain("Started f-docs-site");
});

// SW-338: without a regen the feature cookie falls through to another workspace's upstream.
it("regenerates and reloads the proxy after the service starts", async () => {
  await run({ feature: "f", workspace: null, dev: false, service: "smart-app" });
  expect(reloadProxy).toHaveBeenCalledOnce();
  expect(vi.mocked(startService).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(reloadProxy).mock.invocationCallOrder[0],
  );
});

// SW-835: the whole `up` repairs .claude/settings.json; --service, what every run uses, must too,
// or a deleted ask block stays gone though claude-permissions.json still records it.
it("refreshes the workspace's Claude settings before the service starts", async () => {
  await run({ feature: "f", workspace: null, dev: false, service: "docs-site" });
  expect(refreshWorkspaceSettings).toHaveBeenCalledWith(h.ws);
  expect(vi.mocked(refreshWorkspaceSettings).mock.invocationCallOrder.at(-1)).toBeLessThan(
    vi.mocked(startService).mock.invocationCallOrder.at(-1) as number,
  );
});

// The unpinned autonomous rule lets `--service x <other>` through: it must not rewrite <other>'s settings.
it("leaves another workspace's settings alone", async () => {
  h.own = fs.mkdtempSync(path.join(os.tmpdir(), "up-service-own-"));
  try {
    await run({ feature: "other", workspace: null, dev: false, service: "docs-site" });
  } finally {
    fs.rmSync(h.own, { recursive: true, force: true });
  }
  expect(refreshWorkspaceSettings).not.toHaveBeenCalled();
  expect(startService).toHaveBeenLastCalledWith("other", h.ws, "docs-site", undefined, {
    park: true,
  });
});

it("does not refresh from outside any workspace", async () => {
  h.own = null;
  await run({ feature: "f", workspace: null, dev: false, service: "docs-site" });
  expect(refreshWorkspaceSettings).not.toHaveBeenCalled();
});

// startService refuses there; nothing is written or committed first.
it("does not refresh inside the feature's own container", async () => {
  h.inside = true;
  await run({ feature: "f", workspace: null, dev: false, service: "docs-site" });
  expect(refreshWorkspaceSettings).not.toHaveBeenCalled();
});
