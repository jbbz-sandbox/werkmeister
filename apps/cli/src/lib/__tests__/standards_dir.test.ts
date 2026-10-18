/**
 * `overrides.standards_dir` — the seam between the reusable CLI and one
 * organization's standards content.
 *
 * The loader has always taken a `standardsDir` argument; what was missing was a
 * way to set it. These cover the resolver *and* the no-argument default path,
 * because every real caller (`sandbox standards check`, workspace init, the
 * graduation scaffold) goes through the default rather than passing a directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gc from "werkmeister-core/global_config";
import { loadStandardsModules, validateStandardModules } from "werkmeister-core/standards";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-dir-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "config.yaml");
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("standardsDirPath", () => {
  it("falls back to the bundled tree, so an unconfigured install still works", () => {
    expect(gc.standardsDirPath().endsWith(path.join("docs", "standards"))).toBe(true);
  });

  it("reads overrides.standards_dir", () => {
    gc.save({ overrides: { standards_dir: path.join(tmp, "acme-standards") } });
    expect(gc.standardsDirPath()).toBe(path.join(tmp, "acme-standards"));
  });

  it("expands a leading ~ — the override is hand-written into config.yaml", () => {
    gc.save({ overrides: { standards_dir: "~/acme-standards" } });
    expect(gc.standardsDirPath()).toBe(path.join(os.homedir(), "acme-standards"));
  });
});

describe("non-module files at the tree root", () => {
  it("ignores README.md and friends — a standards repo root always has them", () => {
    const dir = path.join(tmp, "acme-standards");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "README.md"), "# Our standards\n\nNo frontmatter here.\n");
    fs.writeFileSync(path.join(dir, "CONTRIBUTING.md"), "# How to add one\n");
    fs.writeFileSync(
      path.join(dir, "widgets.md"),
      '---\ndomain: widgets\nsummary: Widget rules\napplies_to: ["**/*.widget.ts"]\n---\n\n# Widgets\n',
    );
    gc.save({ overrides: { standards_dir: dir } });

    // Matched on shape (a domain key is lowercase kebab), so the validator sees
    // exactly what the loader loads — it would otherwise report the README as a
    // module with no `domain:`.
    expect(Object.keys(loadStandardsModules(dir))).toEqual(["widgets"]);
    expect(validateStandardModules(dir)).toEqual([]);
  });
});

describe("loadStandardsModules with no directory argument", () => {
  it("loads from the configured tree instead of the bundled one", () => {
    const dir = path.join(tmp, "acme-standards");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "widgets.md"), "---\ndomain: widgets\n---\n\n# Widgets\n");
    gc.save({ overrides: { standards_dir: dir } });

    expect(Object.keys(loadStandardsModules())).toEqual(["widgets"]);
  });
});
