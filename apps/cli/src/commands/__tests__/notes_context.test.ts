/**
 * The SessionStart context is truncated by the harness at ~10k chars, and
 * decisions print after the handoff — so an unbounded list lost its newest
 * decisions, the ones a fresh session needs (known-issues.md, "Session-Start
 * Notes Context Is Unbounded").
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sandbox-core/standards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/standards")>();
  return { ...actual, standardsMatchingDiff: () => [] };
});
vi.mock("sandbox-core/graduate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/graduate")>();
  return { ...actual, reconcileGraduating: () => [] };
});

import { buildContext } from "sandbox-core/notes";

let root: string;

function note(name: string, type: string, body: string): void {
  fs.writeFileSync(
    path.join(root, ".sandbox", "notes", name),
    `---\ntype: ${type}\nstatus: open\n---\n${body}\n`,
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notes-ctx-"));
  fs.mkdirSync(path.join(root, ".sandbox", "notes"), { recursive: true });
  note("001-handoff-start.md", "handoff", "# Handoff\nstart here");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildContext", () => {
  it("stays under the harness cutoff and keeps the newest decisions", () => {
    for (let n = 2; n <= 7; n++) {
      note(`00${n}-decision-d${n}.md`, "decision", `# D${n}\n` + "x".repeat(3000));
    }

    const out = buildContext(root);

    expect(out.length).toBeLessThan(10000);
    expect(out).toContain("Latest handoff: .sandbox/notes/001-handoff-start.md");
    expect(out).toContain("Open decision: .sandbox/notes/007-decision-d7.md");
    expect(out).toContain("Open decision: .sandbox/notes/006-decision-d6.md");
    expect(out).not.toContain("Open decision: .sandbox/notes/002-decision-d2.md");
    // The elided ones still reach the session by path.
    expect(out).toMatch(/4 older open decision note\(s\) not shown/);
    expect(out).toContain("002-decision-d2.md");
    expect(out).toContain("005-decision-d5.md");
  });

  // The doc's observed case: dozens of open decisions with real-length slugs.
  // The elision line has to fit under the cutoff too, or it is what gets cut.
  it("keeps the elision line itself under the cutoff with many decisions", () => {
    const slug = (n: number) => `d${n}-${"a".repeat(50)}`;
    for (let n = 2; n <= 121; n++) {
      note(
        `${String(n).padStart(3, "0")}-decision-${slug(n)}.md`,
        "decision",
        `# D${n}\n` + "x".repeat(40),
      );
    }

    const out = buildContext(root);

    expect(out.length).toBeLessThan(10000);
    expect(out).toContain(`Open decision: .sandbox/notes/121-decision-${slug(121)}.md`);
    expect(out).toMatch(
      /not shown \(context budget\)[^\n]*-decision-d\d+-a+\.md \(and \d+ older\) ──\n$/,
    );
  });

  it("prints every decision, in order, when they fit", () => {
    note("002-decision-a.md", "decision", "# A");
    note("003-decision-b.md", "decision", "# B");

    const out = buildContext(root);

    expect(out).not.toContain("not shown");
    expect(out.indexOf("002-decision-a.md")).toBeLessThan(out.indexOf("003-decision-b.md"));
  });
});
