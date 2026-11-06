/**
 * SW-292: the pre-approved with-fixture-workspace must not read or print files outside the
 * fixture workspace (--print) or the caller's folder (--services).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { inside, parse, run } from "../../commands/fixture.js";

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

it("--exec-runs is a fixture option only first, where the ask rule's prefix sees it (SW-473)", () => {
  const first = parse(["--exec-runs", "--gate", "pr", "gate"]);
  expect(first.opts?.execRuns).toBe(true);
  const later = parse(["--gate", "--exec-runs", "pr", "gate"]);
  expect(later.opts?.execRuns).toBe(false);
  expect(later.steps?.[0]?.[0]).toBe("--exec-runs");
});

it("--pr-field sets only fields no command reads, keeping any = in the value (SW-514)", () => {
  const r = parse(["--pr-field", "skip_release=a=b", "--pr-field", "release=none", "pr", "status"]);
  expect(r.opts?.prFields).toEqual({ skip_release: "a=b", release: "none" });
  expect(r.steps).toEqual([["pr", "status"]]);
  // branch reaches `git push origin <branch>`: --receive-pack=<cmd> would run under the allow rule.
  for (const f of ["branch=--receive-pack=touch x", "session_cwd=/", "status=open"])
    expect(parse(["--pr-field", f, "pr", "gate"])).toEqual({ bad: "--pr-field" });
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

it("--workspace takes only a YAML mapping under the current folder (SW-464)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  for (const [name, body] of [
    ["list.yml", "- a\n"],
    ["scalar.yml", "x\n"],
    ["bad.yml", "{bad"],
  ] as const)
    fs.writeFileSync(path.join(tmp, name), body);
  try {
    for (const args of [
      ["--workspace", "list.yml"],
      ["--workspace", "scalar.yml"],
      ["--workspace", "bad.yml"],
      ["--workspace", "/etc/hosts"],
    ]) {
      error.mockClear();
      await run([...args, "--version"]);
      expect(process.exitCode).toBe(2);
      expect(error.mock.calls[0]?.[0]).toMatch(
        /--workspace: a file under the current folder, holding a YAML mapping/,
      );
    }
  } finally {
    cwd.mockRestore();
    error.mockRestore();
    process.exitCode = 0;
  }
});
