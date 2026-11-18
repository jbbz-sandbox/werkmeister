/** with-temp-home's exit 75 comes from the wait's `spent` flag, not from parsing its note (SW-716). */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const wait = vi.hoisted(() => ({ result: { spent: false, note: "" } }));
vi.mock("werkmeister-core", () => ({ waitForHostLoadNow: async () => wait.result }));

import { run } from "../wait_load.js";

let err: string;
beforeEach(() => {
  err = "";
  process.exitCode = undefined;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    err += `${a.join(" ")}\n`;
  });
});
afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

it("a spent wait exits 75 and says why, whatever the note's wording", async () => {
  wait.result = {
    spent: true,
    note: "load and memory still over after 1.5 min",
  };
  await run();
  expect(process.exitCode).toBe(75);
  expect(err).toMatch(/with-temp-home: load and memory still over after 1\.5 min; not running/);
});

it("a passed wait exits 0 and prints its note; no wait prints nothing", async () => {
  wait.result = { spent: false, note: "waited 30 s for free memory" };
  await run();
  expect(process.exitCode).toBeUndefined();
  expect(err).toBe("with-temp-home: waited 30 s for free memory\n");
  err = "";
  wait.result = { spent: false, note: "" };
  await run();
  expect([process.exitCode, err]).toEqual([undefined, ""]);
});
