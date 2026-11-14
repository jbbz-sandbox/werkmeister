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

it("--slots-full is a fixture option, before the werkmeister args (SW-634)", () => {
  const r = parse(["--slots-full", "workspace", "init", "--no-build"]);
  expect(r.opts?.slotsFull).toBe(true);
  expect(r.steps).toEqual([["workspace", "init", "--no-build"]]);
  expect(parse(["workspace", "init"]).opts?.slotsFull).toBe(false);
});

it("--pr-field sets only fields that reach no git or Claude call, keeping any = in the value (SW-514)", () => {
  const r = parse(["--pr-field", "skip_release=a=b", "--pr-field", "release=none", "pr", "status"]);
  expect(r.opts?.prFields).toEqual({ skip_release: "a=b", release: "none" });
  expect(r.steps).toEqual([["pr", "status"]]);
  // branch reaches `git push origin <branch>`: --receive-pack=<cmd> would run under the allow rule.
  for (const f of [
    "branch=--receive-pack=touch x",
    "session_cwd=/",
    "status=a\nbranch: x",
    "status=a\rb",
    "status=a\u2028b",
  ])
    expect(parse(["--pr-field", f, "pr", "gate"])).toEqual({ bad: "--pr-field" });
});

it("--pr-field status takes one line, kept verbatim with its note (SW-549)", () => {
  const status = "approved  # approved via check-in 2026-11-06";
  expect(parse(["--pr-field", `status=${status}`, "pr", "gate"]).opts?.prFields).toEqual({
    status,
  });
});

it("--issue takes only owner/repo#number, never a gh flag (SW-509)", () => {
  expect(parse(["--issue", "o/app#1", "pr", "status"]).opts?.issue).toBe("o/app#1");
  for (const f of ["SW-1", "o/app", "--repo/x#1", "-o/app#1", "o/app#1 --web"])
    expect(parse(["--issue", f, "pr", "status"])).toEqual({ bad: "--issue" });
  expect(parse(["--issue"])).toEqual({ bad: "--issue" });
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

it("--change takes a path inside the code repo, never one out of it or into .git (SW-664)", () => {
  expect(parse(["--gate", "--change", "plugins/x/y.ts", "pr", "gate"]).opts?.change).toBe(
    "plugins/x/y.ts",
  );
  for (const p of [
    "/etc/hosts",
    "../x",
    "a/../../x",
    ".git/hooks/pre-commit",
    "./.git/config",
    ".GIT/config",
    "a/.git/x",
    "--version",
    "",
  ])
    expect(parse(["--gate", "--change", p, "pr", "gate"])).toEqual({ bad: "--change" });
});

it("--fragment-change outside the current folder is refused, and either option needs --gate (SW-664)", async () => {
  expect(parse(["--gate", "--fragment-change", "/etc/hosts", "pr", "gate"])).toEqual({
    bad: "--fragment-change",
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--change", "docs/z.md", "--version"]);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--change and --fragment-change need --gate/);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--change-base and --change-branch read a file under the current folder and need --change (SW-696)", async () => {
  expect(parse(["--gate", "--change-base", "/etc/hosts", "pr", "gate"])).toEqual({
    bad: "--change-base",
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--gate", "--change-branch", "package.json", "--version"]);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--change-base and --change-branch need --change/);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--config takes only a YAML mapping under the current folder, holding only budget (SW-670)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  fs.writeFileSync(path.join(tmp, "cfg.yml"), "budget:\n  host_load: 0.01\n");
  fs.writeFileSync(path.join(tmp, "paths.yml"), "paths:\n  repos_root: /\n");
  try {
    expect(parse(["--config", "cfg.yml", "budget", "status"]).opts?.config).toEqual({
      budget: { host_load: 0.01 },
    });
    for (const [args, msg] of [
      [["--config", "/etc/hosts"], /--config: a file under the current folder/],
      [["--config", "../secret"], /--config: a file under the current folder/],
      [["--config", "paths.yml"], /--config may not set paths/],
    ] as const) {
      error.mockClear();
      await run([...args, "--version"]);
      expect(process.exitCode).toBe(2);
      expect(error.mock.calls[0]?.[0]).toMatch(msg);
    }
  } finally {
    cwd.mockRestore();
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
