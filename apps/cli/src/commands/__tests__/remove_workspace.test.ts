/**
 * The confirmation gate on `sandbox remove-workspace`.
 *
 * The teardown itself is `sandbox-core`'s and tested there; what is only here
 * is the prompt standing between a mistyped name and an `rm -rf`. If that gate
 * ever inverts, nothing else in the repo notices.
 */
import { beforeEach, expect, it, vi } from "vitest";

vi.mock("sandbox-core", () => ({ removeWorkspace: vi.fn() }));
vi.mock("../../lib/wizard.js", () => ({ confirm: vi.fn() }));

import { removeWorkspace } from "sandbox-core";
import { confirm } from "../../lib/wizard.js";
import { run as runRemove } from "../remove_workspace.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(removeWorkspace).mockResolvedValue({
    command: "handoff + sandbox down + remove ws",
    output: "pushed\ntorn down",
    path: "/features/ws",
  });
});

it("does not delete when the prompt is declined", async () => {
  vi.mocked(confirm).mockResolvedValue(false);
  await runRemove({ name: "ws", yes: false });
  expect(removeWorkspace).not.toHaveBeenCalled();
});

it("deletes when the prompt is accepted", async () => {
  vi.mocked(confirm).mockResolvedValue(true);
  await runRemove({ name: "ws", yes: false });
  expect(removeWorkspace).toHaveBeenCalledWith("ws", { abandon: undefined });
});

it("--yes skips the prompt entirely", async () => {
  await runRemove({ name: "ws", yes: true });
  expect(confirm).not.toHaveBeenCalled();
  expect(removeWorkspace).toHaveBeenCalledWith("ws", { abandon: undefined });
});

it("defaults the prompt to no", async () => {
  vi.mocked(confirm).mockResolvedValue(false);
  await runRemove({ name: "ws", yes: false });
  expect(vi.mocked(confirm).mock.calls[0][1]).toBe(false);
});

it("--abandon passes the reason through to core", async () => {
  await runRemove({ name: "ws", yes: true, abandon: "superseded by #140" });
  expect(removeWorkspace).toHaveBeenCalledWith("ws", { abandon: "superseded by #140" });
});
