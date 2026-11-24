/**
 * SW-1111: start failures tell the session to run `werkmeister feature logs <feature>`. It always
 * followed, so an agent's Bash call (no TTY) never returned. It follows only onto a terminal now.
 */

import { afterEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/compose", () => ({ composeLogs: vi.fn(async () => {}) }));
vi.mock("werkmeister-core/slots", () => ({ getSlot: vi.fn(async () => null) }));

import { composeLogs } from "werkmeister-core/compose";
import { run } from "../logs.js";

const tty = process.stdout.isTTY;
afterEach(() => {
  process.stdout.isTTY = tty;
});

it("prints the recent lines and returns when stdout is not a terminal", async () => {
  process.stdout.isTTY = false;
  await run({ feature: "f", service: null });
  expect(composeLogs).toHaveBeenLastCalledWith(
    "f",
    null,
    expect.objectContaining({ follow: false }),
  );
});

it("follows onto a terminal", async () => {
  process.stdout.isTTY = true;
  await run({ feature: "f", service: "api" });
  expect(composeLogs).toHaveBeenLastCalledWith(
    "f",
    "api",
    expect.objectContaining({ follow: true }),
  );
});
