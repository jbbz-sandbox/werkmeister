/** sessionTitle / claudeSessionCommand — workspace.yml -> `claude --name`. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { claudeSessionCommand, sessionTitle } from "../config.js";

const created: string[] = [];

/** A workspace root; pass null to omit workspace.yml entirely. */
function workspace(configYaml: string | null): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-title-"));
  created.push(root);
  if (configYaml !== null) {
    fs.mkdirSync(path.join(root, ".sandbox"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sandbox", "workspace.yml"), configYaml);
  }
  return root;
}

afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("sessionTitle", () => {
  it("joins the short label to the prose", () => {
    expect(sessionTitle(workspace("task: PROJ-42\ndescription: Add a retry budget\n"))).toBe(
      "PROJ-42 — Add a retry budget",
    );
  });

  it("prefers jira_id over task as the label", () => {
    expect(
      sessionTitle(workspace("jira_id: PROJ-9\ntask: chore\ndescription: Bump deps\n")),
    ).toBe("PROJ-9 — Bump deps");
  });

  it("does not stutter when description already restates the task", () => {
    expect(
      sessionTitle(workspace("task: Add a retry budget\ndescription: Add a retry budget to the client\n")),
    ).toBe("Add a retry budget to the client");
  });

  it("falls back to starting_prompt when there is no description", () => {
    expect(sessionTitle(workspace("task: Sandbox\nstarting_prompt: Wire up Redis\n"))).toBe(
      "Sandbox — Wire up Redis",
    );
  });

  it("uses the label alone when there is no prose", () => {
    expect(sessionTitle(workspace("task: Spike GraphQL federation\n"))).toBe(
      "Spike GraphQL federation",
    );
  });

  it("collapses the newlines YAML folding introduces", () => {
    const folded = "description: Populate the Postgres DB with seed data, connect\n  the backend API\n";
    expect(sessionTitle(workspace(folded))).toBe(
      "Populate the Postgres DB with seed data, connect the backend API",
    );
  });

  it("truncates on a word boundary", () => {
    const title = sessionTitle(workspace(`description: ${"alpha ".repeat(40)}\n`), 24);
    expect(title).toBe("alpha alpha alpha alpha…");
    expect(title!.length).toBeLessThanOrEqual(24);
  });

  it("does not leave dangling punctuation before the ellipsis", () => {
    expect(sessionTitle(workspace("description: Seed the DB, wire the API\n"), 16)).toBe(
      "Seed the DB…",
    );
  });

  it("returns null when the workspace declares no intent", () => {
    expect(sessionTitle(workspace("feature: x\nrepos: y\n"))).toBeNull();
    expect(sessionTitle(workspace(null))).toBeNull();
    expect(sessionTitle(workspace("task: [unclosed\n"))).toBeNull(); // malformed YAML
  });
});

describe("claudeSessionCommand", () => {
  it("quotes the title and escapes shell metacharacters", () => {
    const root = workspace('description: Fix the "weird" $HOME `pwd` bug\n');
    expect(claudeSessionCommand(root)).toBe(
      'claude --name "Fix the \\"weird\\" \\$HOME \\`pwd\\` bug"',
    );
  });

  it("degrades to a bare claude when there is nothing to name", () => {
    expect(claudeSessionCommand(workspace(null))).toBe("claude");
  });
});
