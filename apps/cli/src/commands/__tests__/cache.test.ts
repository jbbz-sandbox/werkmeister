/**
 * `sandbox cache prune` is a thin shell over `pruneCaches` (SW-69), whose
 * rules build-caches.test.mjs pins. This covers the shell: flags reach it,
 * a failed cache sets the exit code, and an unknown action never prunes.
 */

import { afterEach, beforeEach, expect, it, type MockInstance, vi } from "vitest";

vi.mock("werkmeister-core/build_caches", () => ({ pruneCaches: vi.fn() }));

import { pruneCaches } from "werkmeister-core/build_caches";
import { run } from "../cache.js";

let lines: string[];
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  lines = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
  exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  vi.mocked(pruneCaches).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("passes name and flags through and prints one line per cache", async () => {
  vi.mocked(pruneCaches).mockResolvedValue([
    { name: "turbo", action: "max_age", detail: "would delete 3 file(s) older than 14d", ok: true },
  ]);
  await run({ action: "prune", name: "turbo", reset: false, force: true, dry_run: true });
  expect(pruneCaches).toHaveBeenCalledWith({
    name: "turbo",
    reset: false,
    force: true,
    dryRun: true,
  });
  expect(lines.join("\n")).toContain("turbo (max_age): would delete 3 file(s) older than 14d");
  expect(exit).not.toHaveBeenCalled();
});

it("exits nonzero when any cache failed, and prunes every cache when no name is given", async () => {
  vi.mocked(pruneCaches).mockResolvedValue([
    { name: "a", action: "skipped", detail: "not created", ok: true },
    { name: "b", action: "reset", detail: "exit 1", ok: false },
  ]);
  await expect(
    run({ action: "prune", name: null, reset: true, force: false, dry_run: false }),
  ).rejects.toThrow("exit 1");
  expect(pruneCaches).toHaveBeenCalledWith({
    name: undefined,
    reset: true,
    force: false,
    dryRun: false,
  });
  expect(lines.join("\n")).toContain("b (reset): exit 1");
});

it("refuses an unknown action without pruning", async () => {
  await expect(run({ action: "clear" })).rejects.toThrow("exit 2");
  expect(pruneCaches).not.toHaveBeenCalled();
});
