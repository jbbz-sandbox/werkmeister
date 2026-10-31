/**
 * `config --check`'s closing line (SW-162) points at `--write` only when a
 * problem it lists is one `--write` fixes.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/global_config", () => ({ load: () => ({}), check: vi.fn() }));

import { check } from "werkmeister-core/global_config";
import { withReporter } from "werkmeister-core/reporter";
import { run } from "../config.js";
import { makeRecorder } from "./helpers/recorder.js";

let out: string;
beforeEach(() => {
  out = "";
  const capture = (...a: unknown[]) => {
    out += `${a.join(" ")}\n`;
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

/** `config --check`, with the reporter's lines (the closing warn) added to *out*. */
async function checkRun() {
  const { lines, reporter } = makeRecorder();
  try {
    await withReporter(reporter, () => run({ check: true }));
  } finally {
    out += lines.join("\n");
  }
}

it("names --write when a problem is one it fixes", async () => {
  vi.mocked(check).mockReturnValue([
    "/h/env.sh is stale — run `werkmeister machine config --write` to regenerate",
  ]);
  await expect(checkRun()).rejects.toThrow("exit 1");
  expect(out).toContain("run `werkmeister machine config --write` to converge");
});

it("does not name --write when no problem is one it fixes", async () => {
  vi.mocked(check).mockReturnValue([
    "paths.repos_root does not exist: /custom/repos — create it, or set another with `werkmeister machine config --repos-root <path>`",
  ]);
  await expect(checkRun()).rejects.toThrow("exit 1");
  expect(out).not.toContain("to converge");
  expect(out).toContain("problems `--write` does not fix");
});
