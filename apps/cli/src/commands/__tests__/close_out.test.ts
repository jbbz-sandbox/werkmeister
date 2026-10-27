/**
 * The confirmation gate on `sandbox close-out`, which ends in the
 * workspace's `rm -rf`. Close-out's own checks are werkmeister-core's.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core", () => ({ closeOut: vi.fn() }));
vi.mock("werkmeister-core/pr_guard", () => ({ findRecordRoot: vi.fn() }));
vi.mock("../../lib/wizard.js", () => ({ confirm: vi.fn() }));

import { closeOut } from "werkmeister-core";
import { findRecordRoot } from "werkmeister-core/pr_guard";
import { confirm } from "../../lib/wizard.js";
import { run } from "../close_out.js";

const stdinTty = process.stdin.isTTY;
const setTty = (value: boolean | undefined) =>
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });

beforeEach(() => {
  vi.clearAllMocks();
  setTty(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(findRecordRoot).mockReturnValue("/features/sandbox-133-x");
  vi.mocked(closeOut).mockResolvedValue({
    command: "sandbox close-out sandbox-133-x",
    output: "removed",
    path: "/features/sandbox-133-x",
    terminals: [],
  });
});

afterEach(() => {
  setTty(stdinTty);
  vi.restoreAllMocks();
});

it("does nothing when the prompt is declined, and defaults to no", async () => {
  vi.mocked(confirm).mockResolvedValue(false);
  await run({ name: null, yes: false });
  expect(closeOut).not.toHaveBeenCalled();
  expect(vi.mocked(confirm).mock.calls[0][1]).toBe(false);
});

it("refuses without --yes when not run from a terminal, before asking or closing out", async () => {
  setTty(undefined);
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
  await expect(run({ name: "ws", yes: false })).rejects.toThrow("exit 1");
  expect(confirm).not.toHaveBeenCalled();
  expect(closeOut).not.toHaveBeenCalled();
  expect(String(stderr.mock.calls[0][0])).toContain("needs --yes when not run from a terminal");
});

it("--yes still runs without a terminal", async () => {
  setTty(undefined);
  await run({ name: "ws", yes: true });
  expect(closeOut).toHaveBeenCalledWith("ws");
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

it("--abandon passes the reason through and asks about abandoning", async () => {
  vi.mocked(confirm).mockResolvedValue(true);
  await run({ name: "ws", yes: false, abandon: "superseded by #170" });
  expect(vi.mocked(confirm).mock.calls[0][0]).toBe("Abandon and remove 'ws'?");
  expect(closeOut).toHaveBeenCalledWith("ws", { abandon: "superseded by #170" });
});

it("--skip-postmortem passes its reason through, alone or beside --abandon (SW-108)", async () => {
  await run({ name: "ws", yes: true, skipPostmortem: "no time" });
  expect(closeOut).toHaveBeenLastCalledWith("ws", { skipPostmortem: "no time" });
  await run({ name: "ws", yes: true, abandon: "superseded", skipPostmortem: "no time" });
  expect(closeOut).toHaveBeenLastCalledWith("ws", {
    abandon: "superseded",
    skipPostmortem: "no time",
  });
});
