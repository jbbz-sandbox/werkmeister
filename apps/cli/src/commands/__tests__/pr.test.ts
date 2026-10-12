/**
 * `sandbox pr` is argv → core: the workspace comes from the cwd, the action
 * picks the core call, and a failed gate is a non-zero exit (scripts and the
 * agent read the exit code). The gate itself is tested in sandbox-core.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("sandbox-core", () => ({ gatePrs: vi.fn(), openPrs: vi.fn(), refreshPrStatus: vi.fn() }));
vi.mock("sandbox-core/pr_guard", () => ({ findRecordRoot: vi.fn() }));

import { gatePrs, openPrs, refreshPrStatus } from "sandbox-core";
import { findRecordRoot } from "sandbox-core/pr_guard";
import { run } from "../pr.js";

let exit: any; // process.exit's `never` return doesn't fit MockInstance's generic
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  vi.mocked(findRecordRoot).mockReturnValue("/features/ws");
});

it("open goes to openPrs for the workspace and the named repo", async () => {
  vi.mocked(openPrs).mockResolvedValue({ ok: true, lines: ["app: open u"] });
  await run({ action: "open", repo: "app", json: false });
  expect(openPrs).toHaveBeenCalledWith("/features/ws", "app");
  expect(exit).not.toHaveBeenCalled();
});

it("a failed gate exits 1", async () => {
  vi.mocked(gatePrs).mockResolvedValue({ ok: false, lines: ["app: gate FAILED"] });
  await run({ action: "gate", repo: null, json: false });
  expect(gatePrs).toHaveBeenCalledWith("/features/ws", undefined);
  expect(exit).toHaveBeenCalledWith(1);
});

it("status goes to refreshPrStatus", async () => {
  vi.mocked(refreshPrStatus).mockResolvedValue({ lines: ["app: shipped"], changed: true });
  await run({ action: "status", repo: null, json: false });
  expect(refreshPrStatus).toHaveBeenCalledWith("/features/ws");
});

it("outside a workspace it exits 1 without calling core", async () => {
  vi.mocked(findRecordRoot).mockReturnValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
  exit.mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  await expect(run({ action: "open", repo: null, json: false })).rejects.toThrow("exit");
  expect(openPrs).not.toHaveBeenCalled();
});
