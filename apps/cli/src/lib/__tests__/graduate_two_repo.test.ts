/**
 * Graduation straddles two repos: the scaffold lands in the standards tree, the
 * note lives in the workspace, and nothing makes those one transaction.
 *
 * The failure this guards is a graduation that half-lands — scaffold written,
 * note closed, standards commit never made. Marking the note `graduated` at
 * scaffold time is what made that invisible, so the note now stays an open
 * decision until git actually tracks the file.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { graduateNote, reconcileGraduating } from "werkmeister-core/graduate";
import { openDecisions, parseNote } from "werkmeister-core/notes";

let tmp: string;
let workspace: string;
let standardsDir: string;

function git(...args: string[]): void {
  execFileSync("git", ["-C", standardsDir, ...args], { stdio: "ignore" });
}

function seedNote(): Record<string, unknown> {
  const notePath = path.join(workspace, ".werkmeister", "notes", "003-decision-widget-sizing.md");
  fs.writeFileSync(
    notePath,
    "---\ntype: decision\nphase: implement\nauthor: main\nstatus: open\n---\n\n# Widget sizing\n",
  );
  return parseNote(notePath) as unknown as Record<string, unknown>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grad-2repo-"));
  workspace = path.join(tmp, "workspace");
  fs.mkdirSync(path.join(workspace, ".werkmeister", "notes"), { recursive: true });

  standardsDir = path.join(tmp, "standards");
  fs.mkdirSync(path.join(standardsDir, "widgets"), { recursive: true });
  fs.writeFileSync(
    path.join(standardsDir, "widgets", "STANDARD.md"),
    '---\ndomain: widgets\nsummary: Widget rules\napplies_to: ["**/*.widget.ts"]\n---\n\n' +
      "# Widgets\n\n## Rules\n\n- Something\n\n## Don't\n\n- Not that\n",
  );
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a graduation that has not been committed", () => {
  it("leaves the note open, because nothing confirms the rule landed", () => {
    graduateNote(workspace, seedNote(), { domain: "widgets", kind: "example", standardsDir });

    const notePath = path.join(workspace, ".werkmeister", "notes", "003-decision-widget-sizing.md");
    expect(parseNote(notePath)?.frontmatter["status"]).toBe("graduating");
    // The visible consequence: it keeps being offered as an open decision.
    expect(openDecisions(workspace).map((n) => n.slug)).toContain("widget-sizing");
  });

  it("stays open across reconciliation while the scaffold is untracked", () => {
    graduateNote(workspace, seedNote(), { domain: "widgets", kind: "example", standardsDir });
    expect(reconcileGraduating(workspace, standardsDir)).toEqual([]);
    expect(openDecisions(workspace).length).toBe(1);
  });
});

describe("once the scaffold is tracked in the standards tree", () => {
  it("closes the note, so it stops being offered", () => {
    graduateNote(workspace, seedNote(), { domain: "widgets", kind: "example", standardsDir });
    git("add", "-A");

    expect(reconcileGraduating(workspace, standardsDir).length).toBe(1);
    const notePath = path.join(workspace, ".werkmeister", "notes", "003-decision-widget-sizing.md");
    expect(parseNote(notePath)?.frontmatter["status"]).toBe("graduated");
    expect(openDecisions(workspace)).toEqual([]);
  });

  it("keeps `graduated_to` — the note still records where the rule went", () => {
    graduateNote(workspace, seedNote(), { domain: "widgets", kind: "example", standardsDir });
    git("add", "-A");
    reconcileGraduating(workspace, standardsDir);

    const notePath = path.join(workspace, ".werkmeister", "notes", "003-decision-widget-sizing.md");
    expect(parseNote(notePath)?.frontmatter["graduated_to"]).toBe(
      path.join("widgets", "references", "widget-sizing.md"),
    );
  });
});

describe("a standards tree that is not a checkout", () => {
  it("leaves the note graduating rather than claiming the rule landed", () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(path.join(plain, "widgets"), { recursive: true });
    fs.copyFileSync(
      path.join(standardsDir, "widgets", "STANDARD.md"),
      path.join(plain, "widgets", "STANDARD.md"),
    );
    graduateNote(workspace, seedNote(), {
      domain: "widgets",
      kind: "example",
      standardsDir: plain,
    });

    expect(reconcileGraduating(workspace, plain)).toEqual([]);
    expect(openDecisions(workspace).length).toBe(1);
  });
});
