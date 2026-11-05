/**
 * SW-292: the pre-approved with-fixture-workspace must not read or print files outside the
 * fixture workspace (--print) or the caller's folder (--services).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { inside, run } from "../../commands/fixture.js";

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fixture-paths-")));
  fs.mkdirSync(path.join(tmp, "ws", ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "ws", ".werkmeister", "ctx.md"), "x");
  fs.writeFileSync(path.join(tmp, "secret"), "s");
  fs.symlinkSync(path.join(tmp, "secret"), path.join(tmp, "ws", "link"));
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

it("keeps paths under the base and refuses absolute, .. and symlinks out", () => {
  const ws = path.join(tmp, "ws");
  expect(inside(ws, ".werkmeister/ctx.md")).toBe(path.join(ws, ".werkmeister/ctx.md"));
  expect(inside(ws, "missing.md")).toBe(path.join(ws, "missing.md"));
  expect(inside(ws, path.join(tmp, "secret"))).toBeNull();
  expect(inside(ws, "/etc/hosts")).toBeNull();
  expect(inside(ws, "../secret")).toBeNull();
  expect(inside(ws, "link")).toBeNull();
  expect(inside(ws, ".")).toBeNull();
});

it("--services outside the current folder is refused before any fixture is made", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--services", "/etc/hosts", "--version"]);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--services: a file under the current folder/);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});
