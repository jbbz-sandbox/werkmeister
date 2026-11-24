/**
 * SW-1074: `infra intercept --status` runs telepresence directly, before core's guards, so it
 * checks the host-session skip itself: the daemon runs once per user, whatever HOME is.
 */

import { afterEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/telepresence", () => ({ _run: vi.fn(() => [0, ""]) }));

import { _run } from "werkmeister-core/telepresence";

import { run } from "../intercept.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("--status under a with-temp-home HOME or a fixture run calls no telepresence", async () => {
  for (const env of [
    { WERKMEISTER_TEMP_HOME: process.env.HOME ?? "", WERKMEISTER_FIXTURE: "" },
    { WERKMEISTER_TEMP_HOME: "", WERKMEISTER_FIXTURE: "1" },
  ]) {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(run({ status: true })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
  }
  expect(_run).not.toHaveBeenCalled();
});

it("--status outside both still reads telepresence", async () => {
  vi.stubEnv("WERKMEISTER_TEMP_HOME", "");
  vi.stubEnv("WERKMEISTER_FIXTURE", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  await run({ status: true });
  expect(_run).toHaveBeenCalledTimes(2);
});
