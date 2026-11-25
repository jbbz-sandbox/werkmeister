/**
 * SW-292, SW-916: the pre-approved with-fixture-workspace must not read or print files outside the
 * fixture workspace (--print) or the running build's worktree (the file flags).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import type { Fixture } from "werkmeister-core/fixture_workspace";

import { append, inside, parse, run } from "../../commands/fixture.js";

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
  expect(later.steps?.[0]).toEqual(["--exec-runs", "pr", "gate"]);
});

it("--slots-full is a fixture option, before the werkmeister args (SW-634)", () => {
  const r = parse(["--slots-full", "workspace", "init", "--no-build"]);
  expect(r.opts?.slotsFull).toBe(true);
  expect(r.steps).toEqual([["workspace", "init", "--no-build"]]);
  expect(parse(["workspace", "init"]).opts?.slotsFull).toBe(false);
});

it("--running reads five tab-separated columns a line, --queue a comma list (SW-685)", () => {
  fs.writeFileSync(
    path.join(tmp, "running.tsv"),
    "holder\tws\t2026-11-13T00:00:00Z\t0\t6000000000\n\n",
  );
  fs.writeFileSync(path.join(tmp, "short.tsv"), "holder\tws\t2026-11-13T00:00:00Z\t0\n");
  const r = parse(["--running", "running.tsv", "--queue", "a,b", "budget", "status"], tmp);
  expect(r.opts?.containers).toEqual([
    {
      feature: "holder",
      workspace: "ws",
      startedAt: "2026-11-13T00:00:00Z",
      memory: 0,
      nanoCpus: 6e9,
    },
  ]);
  expect(r.opts?.queue).toEqual(["a", "b"]);
  // SW-809: an entry with a wait is one waiter, its commas are services; --queue repeats.
  expect(
    parse(["--queue", "a,b", "--queue", "head:239:api,web", "budget", "status"], tmp).opts?.queue,
  ).toEqual(["a", "b", "head:239:api,web"]);
  expect(r.steps).toEqual([["budget", "status"]]);
  expect(parse(["--running", "short.tsv", "budget", "status"], tmp)).toEqual({ bad: "--running" });
  // SW-1147: a 7th column, asking, takes 0 or 1 only.
  const row = "holder\tws\t2026-11-13T00:00:00Z\t0\t6000000000\t1";
  for (const [asking, want] of [
    ["1", { execs: 1, asking: true }],
    ["0", { execs: 1 }],
  ] as const) {
    fs.writeFileSync(path.join(tmp, "asking.tsv"), `${row}\t${asking}\n`);
    expect(parse(["--running", "asking.tsv", "budget", "status"], tmp).opts?.containers).toEqual([
      expect.objectContaining(want),
    ]);
  }
  expect(
    parse(["--running", "asking.tsv", "budget", "status"], tmp).opts?.containers?.[0],
  ).not.toHaveProperty("asking");
  for (const bad of ["yes", "2", ""]) {
    fs.writeFileSync(path.join(tmp, "asking.tsv"), `${row}\t${bad}\n`);
    expect(parse(["--running", "asking.tsv", "budget", "status"], tmp)).toEqual({
      bad: "--running",
    });
  }
  expect(parse(["--running", "secret-missing", "budget", "status"], tmp)).toEqual({
    bad: "--running",
  });
  // Out of the worktree: the refusal names where it resolved (SW-1083).
  expect(parse(["--running", "../secret", "budget", "status"], tmp)).toEqual({
    bad: "--running",
    file: path.join(path.dirname(tmp), "secret"),
    base: tmp,
  });
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

it("--pr-line keeps a raw line unquoted, only for --pr-field's keys and one line (SW-851)", async () => {
  const line = "skip_release: no changeset: test-only";
  const r = parse(["--pr-line", line, "--pr-line", "release: none", "pr", "gate"]);
  expect(r.opts?.prLines).toEqual([line, "release: none"]);
  for (const f of [
    "branch: --receive-pack=x",
    "status: approved",
    "skip_release:x",
    "skip_release: ",
    "release: a\nbranch: x",
    "release: a\u2028b",
    "",
  ])
    expect(parse(["--pr-line", f, "pr", "gate"])).toEqual({ bad: "--pr-line" });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--pr-line", line, "--version"]);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--pr-line needs --gate/);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--issue takes only owner/repo#number, never a gh flag (SW-509)", () => {
  expect(parse(["--issue", "o/app#1", "pr", "status"]).opts?.issue).toBe("o/app#1");
  for (const f of ["SW-1", "o/app", "--repo/x#1", "-o/app#1", "o/app#1 --web"])
    expect(parse(["--issue", f, "pr", "status"])).toEqual({ bad: "--issue" });
  expect(parse(["--issue"])).toEqual({ bad: "--issue" });
});

it("--services outside the worktree is refused before any fixture is made", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--services", "/etc/hosts", "--version"]);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--services: a file under the worktree/);
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

it("--fragment-change outside the worktree is refused, and either option needs --gate (SW-664)", async () => {
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

it("--change-base and --change-branch read a file under the worktree and need --change (SW-696)", async () => {
  expect(parse(["--gate", "--change-base", "/etc/hosts", "pr", "gate"])).toEqual({
    bad: "--change-base",
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--gate", "--change-branch", "secret", "--version"], tmp);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--change-base and --change-branch need --change/);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--config takes only a YAML mapping under the worktree, holding only budget (SW-670)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.writeFileSync(path.join(tmp, "cfg.yml"), "budget:\n  host_load: 0.01\n");
  fs.writeFileSync(path.join(tmp, "paths.yml"), "paths:\n  repos_root: /\n");
  try {
    expect(parse(["--config", "cfg.yml", "budget", "status"], tmp).opts?.config).toEqual({
      budget: { host_load: 0.01 },
    });
    for (const [args, msg] of [
      [["--config", "/etc/hosts"], /--config: a file under the worktree/],
      [["--config", "../secret"], /--config: a file under the worktree/],
      [["--config", "paths.yml"], /--config may not set paths/],
    ] as const) {
      error.mockClear();
      await run([...args, "--version"], tmp);
      expect(process.exitCode).toBe(2);
      expect(error.mock.calls[0]?.[0]).toMatch(msg);
    }
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--workspace takes only a YAML mapping under the worktree (SW-464)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
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
      await run([...args, "--version"], tmp);
      expect(process.exitCode).toBe(2);
      expect(error.mock.calls[0]?.[0]).toMatch(
        /--workspace: a file under the worktree(, holding a YAML mapping$|; \/etc\/hosts is not under )/,
      );
    }
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--postmortem, --worktrees and --jira are fixture options, not werkmeister args (SW-896)", () => {
  const p = parse(["--postmortem", "--worktrees", "--jira", "pr", "push"]);
  expect(p.opts).toMatchObject({ postmortem: true, worktrees: true, jira: true });
  expect(p.steps).toEqual([["pr", "push"]]);
});

it("--workspace refuses a key outside its allowlist with exit 2 (SW-900)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.writeFileSync(path.join(tmp, "feature.yml"), "group: [SW-2]\nfeature: ../x\n");
  try {
    await run(["--workspace", "feature.yml", "--version"], tmp);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toMatch(/--workspace may not set feature: only /);
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("refuses every file flag when the running build is not <wt>/apps/cli/dist/main.js (SW-1064)", () => {
  // An npm global install: `../../..` of <prefix>/lib/node_modules/werkmeister/dist/main.js is <prefix>/lib.
  const main = path.join(tmp, "lib", "node_modules", "werkmeister", "dist", "main.js");
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(path.join(tmp, "lib", "secret.yml"), "a: 1\n");
  const argv1 = process.argv[1];
  process.argv[1] = main;
  try {
    expect(parse(["--workspace", "secret.yml", "status"])).toEqual({ bad: "--workspace" });
  } finally {
    process.argv[1] = argv1;
  }
});

it("--workflow reads workflow.yaml and stages/*.md from a folder under the worktree (SW-1108)", () => {
  const wf = path.join(tmp, "ws", "flows", "review");
  fs.mkdirSync(path.join(wf, "stages"), { recursive: true });
  fs.writeFileSync(path.join(wf, "workflow.yaml"), "version: 1\n");
  fs.writeFileSync(path.join(wf, "stages", "triage.md"), "One job.\n");
  fs.writeFileSync(path.join(wf, "notes.txt"), "not copied\n");
  const r = parse(
    ["--workflow", "flows/review", "--workflow-in", "repo", "status"],
    path.join(tmp, "ws"),
  );
  expect(r.opts?.workflow).toEqual({
    type: "review",
    files: { "workflow.yaml": "version: 1\n", "stages/triage.md": "One job.\n" },
    in: "repo",
  });
  // Outside the worktree, a folder with no workflow.yaml, and any --workflow-in but repo.
  expect(parse(["--workflow", "../secret", "status"], path.join(tmp, "ws"))).toEqual({
    bad: "--workflow",
  });
  expect(parse(["--workflow", "flows", "status"], path.join(tmp, "ws"))).toEqual({
    bad: "--workflow",
  });
  expect(parse(["--workflow-in", "home", "status"])).toEqual({ bad: "--workflow-in" });
});

it("a missing --workflow folder is refused with where it resolved, not a stack trace (SW-1167)", async () => {
  const ws = path.join(tmp, "ws");
  expect(parse(["--workflow", "nope/flow", "status"], ws)).toEqual({
    bad: "--workflow",
    file: path.join(ws, "nope", "flow"),
    base: ws,
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await run(["--workflow", "nope/flow", "status"], ws);
    expect(process.exitCode).toBe(2);
    expect(error.mock.calls[0]?.[0]).toBe(
      `--workflow: ${path.join(ws, "nope", "flow")} is not a folder (resolved against ${ws}, the worktree of the running CLI): pass a folder under it holding workflow.yaml`,
    );
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--then-append is a step that edits only seeded workflow files or fixture markdown (SW-1108)", () => {
  expect(
    parse([
      "workspace",
      "init",
      "--then-append",
      "workflow:stages/triage.md",
      "x",
      "--then",
      "skills",
      "check",
    ]).steps,
  ).toEqual([
    ["workspace", "init"],
    { append: "workflow:stages/triage.md", text: "x" },
    ["skills", "check"],
  ]);
  expect(
    parse(["status", "--then-append", "stages/01_research/CONTEXT.md", "x"]).steps?.[1],
  ).toEqual({
    append: "stages/01_research/CONTEXT.md",
    text: "x",
  });
  // The wrapper is pre-approved: never .git (an appended config runs commands), a script, or out of the fixture.
  for (const target of [
    "app/.git/config",
    "app/.GIT/x.md",
    ".werkmeister/bin/with-temp-home",
    "../x.md",
    "/abs.md",
    "workflow:../x.md",
    "workflow:other.yaml",
  ])
    expect(parse(["status", "--then-append", target, "x"]), target).toEqual({
      bad: "--then-append",
    });
  // Needs its text, and --then before the next werkmeister args.
  expect(parse(["status", "--then-append", "a.md"])).toEqual({ bad: "--then-append" });
  expect(parse(["status", "--then-append", "a.md", "x", "skills", "check"])).toEqual({
    bad: "--then-append",
  });
});

it("--then-append first, or workflow: and --workflow-in without --workflow, exit 2 before any fixture (SW-1108)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const argv of [
      ["--then-append", "a.md", "x"],
      ["status", "--then-append", "workflow:workflow.yaml", "x"],
      ["--workflow-in", "repo", "status"],
    ]) {
      await run(argv, tmp);
      expect(process.exitCode, argv.join(" ")).toBe(2);
      process.exitCode = 0;
    }
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--workflow refuses a stages/ symlinked out of the worktree before listing it (SW-1108)", () => {
  const wf = path.join(tmp, "ws", "flows", "linked");
  fs.mkdirSync(wf, { recursive: true });
  fs.writeFileSync(path.join(wf, "workflow.yaml"), "version: 1\n");
  fs.mkdirSync(path.join(tmp, "out-stages"), { recursive: true });
  fs.symlinkSync(path.join(tmp, "out-stages"), path.join(wf, "stages"));
  expect(parse(["--workflow", "flows/linked", "status"], path.join(tmp, "ws"))).toEqual({
    bad: "--workflow",
  });
});

it("a file flag outside the worktree names the path and the base it must be under (SW-1083)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  // A host absolute path seen from the container: the file exists, just not under the base.
  fs.writeFileSync(path.join(tmp, "host.yml"), "a: 1\n");
  const ws = path.join(tmp, "ws");
  try {
    for (const flag of ["--workspace", "--config", "--services"]) {
      error.mockClear();
      await run([flag, path.join(tmp, "host.yml"), "--version"], ws);
      expect(process.exitCode, flag).toBe(2);
      expect(error.mock.calls[0]?.[0]).toBe(
        `${flag}: a file under the worktree; ${path.join(tmp, "host.yml")} is not under ${ws} (the worktree, as this process sees it): pass it relative to the worktree`,
      );
    }
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--workflow refuses a stage file symlinked out of the worktree, and a dangling one (SW-1119)", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const ws = path.join(tmp, "ws");
  fs.writeFileSync(path.join(tmp, "out-stage.md"), "outside\n");
  for (const [name, target] of [
    ["linkfile", path.join(tmp, "out-stage.md")],
    ["dangling", path.join(tmp, "no-such-stage.md")],
  ] as const) {
    const wf = path.join(ws, "flows", name);
    fs.mkdirSync(path.join(wf, "stages"), { recursive: true });
    fs.writeFileSync(path.join(wf, "workflow.yaml"), "version: 1\n");
    fs.symlinkSync(target, path.join(wf, "stages", "x.md"));
  }
  try {
    for (const name of ["linkfile", "dangling"]) {
      const argv = ["--workflow", `flows/${name}`, "status"];
      expect(parse(argv, ws), name).toEqual({ bad: "--workflow" });
      error.mockClear();
      await run(argv, ws);
      expect(process.exitCode, name).toBe(2);
      expect(error.mock.calls[0]?.[0]).toMatch(/--workflow: a folder under the worktree/);
    }
  } finally {
    error.mockRestore();
    process.exitCode = 0;
  }
});

it("--then-append refuses a fixture .md or workflow stage symlinked out of the fixture (SW-1119)", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const fx = path.join(tmp, "append-fx");
  const workspace = path.join(fx, "ws");
  const workflowDir = path.join(fx, "wf");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(workflowDir, "stages"), { recursive: true });
  const outside = path.join(tmp, "append-target.md");
  fs.writeFileSync(outside, "kept\n");
  fs.symlinkSync(outside, path.join(workspace, "notes.md"));
  fs.symlinkSync(outside, path.join(workflowDir, "stages", "x.md"));
  try {
    for (const target of ["notes.md", "workflow:stages/x.md"]) {
      expect(
        append({ append: target, text: "appended" }, { workspace, workflowDir } as Fixture),
        target,
      ).toBe(2);
    }
    expect(fs.readFileSync(outside, "utf8")).toBe("kept\n");
  } finally {
    error.mockRestore();
  }
});

it("--pr-field url takes only a PR link on the fixture's own o/ repos (SW-1126)", () => {
  const ok = parse(["--gate", "--pr-field", "url=https://github.com/o/app/pull/7", "pr", "status"]);
  expect(ok.opts?.prFields).toEqual({ url: "https://github.com/o/app/pull/7" });
  for (const v of [
    "url=--repo=x",
    "url=https://github.com/other/app/pull/7",
    "url=https://github.com/o/app/pull/7\nbranch: x",
    "url=http://github.com/o/app/pull/7",
  ])
    expect(parse(["--gate", "--pr-field", v, "pr", "status"]), v).toEqual({ bad: "--pr-field" });
});
