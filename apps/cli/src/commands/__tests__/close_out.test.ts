/**
 * The confirmation gate on `sandbox close-out`, which ends in the same
 * `rm -rf` as remove-workspace. Close-out's own checks are sandbox-core's.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("sandbox-core", () => ({ closeOut: vi.fn() }));
vi.mock("sandbox-core/pr_guard", () => ({ findRecordRoot: vi.fn() }));
vi.mock("../../lib/wizard.js", () => ({ confirm: vi.fn() }));

import { closeOut } from "sandbox-core";
import { findRecordRoot } from "sandbox-core/pr_guard";
import { confirm } from "../../lib/wizard.js";
import { run } from "../close_out.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(findRecordRoot).mockReturnValue("/features/sandbox-133-x");
  vi.mocked(closeOut).mockResolvedValue({ command: "sandbox close-out sandbox-133-x", output: "removed" });
});

it("does nothing when the prompt is declined, and defaults to no", async () => {
  vi.mocked(confirm).mockResolvedValue(false);
  await run({ name: null, yes: false });
  expect(closeOut).not.toHaveBeenCalled();
  expect(vi.mocked(confirm).mock.calls[0][1]).toBe(false);
});

it("defaults the name to the workspace the cwd is in", async () => {
  await run({ name: null, yes: true });
  expect(confirm).not.toHaveBeenCalled();
  expect(closeOut).toHaveBeenCalledWith("sandbox-133-x");
});

it("an explicit name wins", async () => {
  await run({ name: "other", yes: true });
  expect(closeOut).toHaveBeenCalledWith("other");
});
