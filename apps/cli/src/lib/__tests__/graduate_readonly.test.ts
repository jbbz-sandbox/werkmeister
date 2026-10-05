/**
 * Graduation writes *into* the standards tree, which `overrides.standards_dir`
 * can point at a directory this machine only reads. The precondition matters
 * more than it looks: `sandbox down` reports a GraduationError but swallows
 * everything else so teardown is never blocked, so an EACCES escaping from the
 * write would present as a graduation that silently did nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GraduationError, graduateNote } from "sandbox-core/graduate";

let tmp: string;
let standardsDir: string;

/** A minimal eligible domain: `## Rules` + `## Don't` is what makes it graduable. */
function writeDomain(): void {
  const dir = path.join(standardsDir, "widgets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STANDARD.md"),
    '---\ndomain: widgets\nsummary: Widget rules\napplies_to: ["**/*.widget.ts"]\n---\n\n' +
      "# Widgets\n\n## Rules\n\n- Something\n\n## Don't\n\n- Not that\n",
  );
}

/** A `decision` note in the shape `lib/notes.parseNote()` produces. */
function note(): Record<string, any> {
  const notePath = path.join(tmp, "003-decision-widget-sizing.md");
  fs.writeFileSync(notePath, "---\ntype: decision\nstatus: open\n---\n\n# Widget sizing\n");
  return {
    type: "decision",
    path: notePath,
    number: 3,
    slug: "widget-sizing",
    frontmatter: { status: "open" },
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grad-ro-"));
  standardsDir = path.join(tmp, "standards");
  fs.mkdirSync(standardsDir);
  writeDomain();
});
afterEach(() => {
  // Restore write permission first, or the cleanup itself fails.
  fs.chmodSync(path.join(standardsDir, "widgets"), 0o755);
  fs.chmodSync(path.join(standardsDir, "widgets", "STANDARD.md"), 0o644);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("graduateNote against a read-only standards tree", () => {
  // The two kinds write different things, so they are blocked by different
  // permissions: a rule rewrites STANDARD.md in place, a reference creates a
  // file under references/. A guard on only one of them leaves the other raw.
  it("refuses a `rule` when STANDARD.md itself is read-only", () => {
    fs.chmodSync(path.join(standardsDir, "widgets", "STANDARD.md"), 0o444);
    expect(() =>
      graduateNote(tmp, note(), { domain: "widgets", kind: "rule", standardsDir }),
    ).toThrow(GraduationError);
  });

  it("refuses an `example` when the domain directory is read-only", () => {
    fs.chmodSync(path.join(standardsDir, "widgets"), 0o555);
    expect(() =>
      graduateNote(tmp, note(), { domain: "widgets", kind: "example", standardsDir }),
    ).toThrow(GraduationError);
  });

  it("does not refuse a `rule` merely because the directory is read-only", () => {
    // The file stays writable, so the in-place rewrite genuinely succeeds —
    // guarding the tree root instead would have rejected this.
    fs.chmodSync(path.join(standardsDir, "widgets"), 0o555);
    const result = graduateNote(tmp, note(), { domain: "widgets", kind: "rule", standardsDir });
    expect(fs.readFileSync(result["scaffold_path"], "utf8")).toContain("TODO(graduate)");
  });

  it("still scaffolds a reference when the tree is writable", () => {
    const result = graduateNote(tmp, note(), { domain: "widgets", kind: "example", standardsDir });
    expect(fs.readFileSync(result["scaffold_path"], "utf8")).toContain("TODO(graduate)");
  });
});
