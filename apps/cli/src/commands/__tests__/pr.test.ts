/**
 * `sandbox pr` is argv → core: the workspace comes from the cwd, the action
 * picks the core call, and a failed gate is a non-zero exit (scripts and the
 * agent read the exit code). The gate itself is tested in werkmeister-core.
 */
import { beforeEach, expect, it, type MockInstance, vi } from "vitest";

vi.mock("werkmeister-core", () => ({
  adoptPr: vi.fn(),
  gatePrs: vi.fn(),
  gateTests: vi.fn(),
  openPrs: vi.fn(),
  refreshPrStatus: vi.fn(),
  watchPrs: vi.fn(),
}));
vi.mock("werkmeister-core/pr_guard", () => ({ findRecordRoot: vi.fn() }));

import { adoptPr, gatePrs, gateTests, openPrs, refreshPrStatus, watchPrs } from "werkmeister-core";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { run } from "../pr.js";

let exit: MockInstance; // untyped: process.exit's `never` return doesn't fit MockInstance<typeof process.exit>
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

it("--no-wait is still accepted and changes nothing: the gate never waits on load (SW-542)", async () => {
  vi.mocked(gatePrs).mockResolvedValue({ ok: true, lines: [] });
  vi.mocked(openPrs).mockResolvedValue({ ok: true, lines: [] });
  await run({ action: "gate", repo: null, wait: false, json: false });
  expect(gatePrs).toHaveBeenCalledWith("/features/ws", undefined);
  await run({ action: "open", repo: "app", wait: false, json: false });
  expect(openPrs).toHaveBeenCalledWith("/features/ws", "app");
});

it("--tests reaches gateTests, not gatePrs (SW-316)", async () => {
  vi.mocked(gateTests).mockResolvedValue({ ok: true, lines: [] });
  await run({ action: "gate", repo: "app", tests: true, wait: false, json: false });
  expect(gateTests).toHaveBeenCalledWith("/features/ws", "app");
  expect(gatePrs).not.toHaveBeenCalled();
});

it("open ends its output with its own exit line, for a pass and a failed gate (SW-527)", async () => {
  vi.mocked(openPrs).mockResolvedValueOnce({ ok: true, lines: ["app: open u"] });
  await run({ action: "open", repo: null, json: false });
  expect(console.log).toHaveBeenLastCalledWith("app: open u\npr open: exit 0");
  vi.mocked(openPrs).mockResolvedValueOnce({ ok: false, lines: ["app: gate FAILED"] });
  await run({ action: "open", repo: null, json: false });
  expect(console.log).toHaveBeenLastCalledWith("app: gate FAILED\npr open: exit 1");
  expect(exit).toHaveBeenCalledWith(1);
});

it("the exit line is not added to --json output or to gate (SW-527)", async () => {
  vi.mocked(openPrs).mockResolvedValueOnce({ ok: true, lines: ["app: open u"] });
  await run({ action: "open", repo: null, json: true });
  expect(JSON.parse(vi.mocked(console.log).mock.calls.at(-1)?.[0] as string).lines).toEqual([
    "app: open u",
  ]);
  vi.mocked(gatePrs).mockResolvedValueOnce({ ok: true, lines: ["app: gate ok"] });
  await run({ action: "gate", repo: null, json: false });
  expect(console.log).toHaveBeenLastCalledWith("app: gate ok");
});

it("a failed gate exits 1", async () => {
  vi.mocked(gatePrs).mockResolvedValue({ ok: false, lines: ["app: gate FAILED"] });
  await run({ action: "gate", repo: null, json: false });
  expect(gatePrs).toHaveBeenCalledWith("/features/ws", undefined);
  expect(exit).toHaveBeenCalledWith(1);
});

it("status goes to refreshPrStatus", async () => {
  vi.mocked(refreshPrStatus).mockResolvedValue({
    lines: ["app: shipped"],
    changed: true,
    views: new Map(),
  });
  await run({ action: "status", repo: null, json: false });
  expect(refreshPrStatus).toHaveBeenCalledWith("/features/ws");
});

it("adopt goes to adoptPr with the PR, or with --no-pr's reason", async () => {
  vi.mocked(adoptPr).mockResolvedValue({ ok: true, lines: ["app: adopted as merged"] });
  await run({ action: "adopt", pr: "140", noPr: null, repo: "app", json: false });
  expect(adoptPr).toHaveBeenCalledWith("/features/ws", { pr: "140", noPr: undefined, repo: "app" });
  await run({ action: "adopt", pr: null, noPr: "fixed on main", repo: null, json: false });
  expect(adoptPr).toHaveBeenLastCalledWith("/features/ws", {
    pr: undefined,
    noPr: "fixed on main",
    repo: undefined,
  });
});

it("watch runs from anywhere and leaves desktop callbacks to the mod", async () => {
  vi.mocked(findRecordRoot).mockReturnValue(null);
  vi.mocked(watchPrs).mockResolvedValue({ ok: true, lines: [], desktop: [] });
  await run({ action: "watch", repo: null, json: false });
  expect(watchPrs).toHaveBeenCalledWith({ desktop: false });
  expect(exit).not.toHaveBeenCalled();
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
