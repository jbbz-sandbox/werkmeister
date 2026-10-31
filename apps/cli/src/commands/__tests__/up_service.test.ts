/**
 * `werkmeister feature up --service <name>` (SW-132) starts that one service
 * through the PR gate's `startService`, not the whole `up`.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/lifecycle", () => ({ startService: vi.fn(), up: vi.fn() }));
vi.mock("../../lib/config.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/config.js")>()),
  resolveWorkspace: () => "/ws/f",
}));

import { startService, up } from "werkmeister-core/lifecycle";
import { run } from "../up.js";

let lines: string[];
beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
});
afterEach(() => vi.restoreAllMocks());

it("starts only the named service in the feature's workspace", async () => {
  await run({ feature: "f", workspace: null, dev: false, service: "docs-site" });
  expect(startService).toHaveBeenCalledWith("f", "/ws/f", "docs-site");
  expect(up).not.toHaveBeenCalled();
  expect(lines.join("\n")).toContain("Started f-docs-site");
});
