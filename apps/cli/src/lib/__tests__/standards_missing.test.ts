/**
 * A missing standards tree must be loud everywhere a human is watching.
 *
 * The default `~/.werkmeister/standards` exists only once `machine setup` has
 * seeded it (SW-640), and a configured tree can be gone. `loadStandardsModules` treats that as "no modules" and
 * carries on, which is correct for a hook that must never block a launch, and
 * is exactly why nothing else can afford to stay quiet about it.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gc from "werkmeister-core/global_config";
import { syncRegistryConfigs } from "werkmeister-core/machine_setup";
import { loadStandardsModules } from "werkmeister-core/standards";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-missing-"));
  process.env.WERKMEISTER_CONFIG_FILE = path.join(tmp, "config.yaml");
});
afterEach(() => {
  delete process.env.WERKMEISTER_CONFIG_FILE;
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

  it("is empty once machine setup has run on an unconfigured install (SW-640)", () => {
    gc.save({});
    expect(syncRegistryConfigs(true, { legacyDir: null }).at(-1)?.detail).toContain("would create");
    expect(fs.existsSync(path.join(tmp, "standards"))).toBe(false);
    syncRegistryConfigs(false, { legacyDir: null });
    expect(gc.standardsDirProblem()).toBe("");
    expect(fs.existsSync(path.join(tmp, "standards", "README.md"))).toBe(true);
    // A configured tree is the person's: setup names it and creates nothing.
    gc.save({ overrides: { standards_dir: path.join(tmp, "gone") } });
    syncRegistryConfigs(false, { legacyDir: null });
    expect(fs.existsSync(path.join(tmp, "gone"))).toBe(false);
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
