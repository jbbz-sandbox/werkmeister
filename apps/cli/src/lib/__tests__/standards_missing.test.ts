/**
 * A missing standards tree must be loud everywhere a human is watching.
 *
 * The fallback in `standardsDirPath()` is a convention (a tree bundled beside
 * the CLI), not a promise — this repo stopped shipping one when the standards
 * moved to their own repo, so an unconfigured install resolves a directory that
 * does not exist. `loadStandardsModules` treats that as "no modules" and
 * carries on, which is correct for a hook that must never block a launch, and
 * is exactly why nothing else can afford to stay quiet about it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as gc from "sandbox-core/global_config";
import { loadStandardsModules } from "../standards.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-missing-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "config.yaml");
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("standardsDirProblem", () => {
  it("names the config key when nothing is configured", () => {
    gc.save({});
    const problem = gc.standardsDirProblem();
    expect(problem).toContain("overrides.standards_dir");
    expect(problem).toContain("unset");
  });

  it("distinguishes a configured-but-absent tree from an unset one", () => {
    gc.save({ overrides: { standards_dir: path.join(tmp, "gone") } });
    const problem = gc.standardsDirProblem();
    expect(problem).toContain("not found");
    expect(problem).toContain(path.join(tmp, "gone"));
    expect(problem).not.toContain("unset");
  });

  it("is empty once the tree exists", () => {
    const dir = path.join(tmp, "standards");
    fs.mkdirSync(dir);
    gc.save({ overrides: { standards_dir: dir } });
    expect(gc.standardsDirProblem()).toBe("");
  });
});

describe("config drift check", () => {
  it("reports the missing tree, so `sandbox config --check` catches it", () => {
    gc.save({ overrides: { standards_dir: path.join(tmp, "gone") } });
    expect(gc.check(gc.load()).join("\n")).toContain("standards tree not found");
  });
});

describe("the fail-open loader is deliberately unchanged", () => {
  it("still returns no modules rather than throwing — it feeds a launch hook", () => {
    gc.save({ overrides: { standards_dir: path.join(tmp, "gone") } });
    expect(loadStandardsModules()).toEqual({});
  });
});
