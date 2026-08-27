/**
 * Generated skills link back to the standards tree by absolute URL, because the
 * workspaces that read them have no standards checkout. Which repo those URLs
 * name is derived from the tree's own git checkout rather than hardcoded — an
 * org that points `overrides.standards_dir` at its own tree must not get links
 * silently resolving against this one.
 *
 * The prefix half is a regression guard too: it was hardcoded `docs/standards`
 * while this repo's tree sits at `apps/cli/docs/standards`, so every generated
 * link 404'd.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as gc from "sandbox-core/global_config";
import { generateSkills, standardsSource, standardsUrl } from "../skill_gen.js";

let tmp: string;

/** A standards tree at <repo>/docs/standards inside a git repo with *remote*. */
function makeTree(remote: string | null): string {
  const repo = fs.mkdtempSync(path.join(tmp, "repo-"));
  const dir = path.join(repo, "docs", "standards");
  fs.mkdirSync(dir, { recursive: true });
  if (remote !== null) {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
  }
  gc.save({ overrides: { standards_dir: dir } });
  return dir;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "std-links-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "config.yaml");
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("standardsSource", () => {
  it("derives owner/repo from an ssh remote, and the prefix from the tree's position", () => {
    makeTree("git@github.com:acme/eng-standards.git");
    expect(standardsSource()).toEqual({
      base: "https://github.com/acme/eng-standards",
      prefix: "docs/standards",
    });
  });

  it("normalizes an https remote, .git suffix and all", () => {
    makeTree("https://github.com/acme/eng-standards.git");
    expect(standardsSource()?.base).toBe("https://github.com/acme/eng-standards");
  });

  it("is null when the tree is not a checkout — a package or a plain directory", () => {
    makeTree(null);
    expect(standardsSource()).toBeNull();
  });
});

describe("standardsUrl", () => {
  it("joins the tree prefix and targets HEAD, not a pinned branch name", () => {
    const src = { base: "https://github.com/acme/eng-standards", prefix: "docs/standards" };
    expect(standardsUrl(src, "config/references/x.md")).toBe(
      "https://github.com/acme/eng-standards/blob/HEAD/docs/standards/config/references/x.md",
    );
    expect(standardsUrl(src, "", "tree")).toBe(
      "https://github.com/acme/eng-standards/tree/HEAD/docs/standards",
    );
  });

  it("resolves `..` rather than emitting a URL containing it", () => {
    const src = { base: "https://github.com/acme/std", prefix: "docs/standards" };
    expect(standardsUrl(src, "../design.md")).toBe(
      "https://github.com/acme/std/blob/HEAD/docs/design.md",
    );
  });

  it("handles a tree at its repo's root — the layout a dedicated standards repo has", () => {
    const src = { base: "https://github.com/acme/std", prefix: "" };
    expect(standardsUrl(src, "", "tree")).toBe("https://github.com/acme/std/tree/HEAD");
    expect(standardsUrl(src, "config/x.md")).toBe(
      "https://github.com/acme/std/blob/HEAD/config/x.md",
    );
  });

  it("returns empty for an underivable source, so callers can drop the link", () => {
    expect(standardsUrl(null, "anything.md")).toBe("");
  });
});

describe("generateSkills link rewriting", () => {
  function writeModule(dir: string, body: string): void {
    fs.writeFileSync(
      path.join(dir, "widgets.md"),
      `---\ndomain: widgets\nsummary: Widget rules\napplies_to: ["**/*.widget.ts"]\nphase: implement\n---\n\n${body}\n`,
    );
  }

  it("rewrites a doc-relative link to the derived tree URL", () => {
    const dir = makeTree("git@github.com:acme/eng-standards.git");
    writeModule(dir, "See [the notes](repos/widgets.md).");
    expect(generateSkills()["sb-widgets-standard"]["SKILL.md"]).toContain(
      "[the notes](https://github.com/acme/eng-standards/blob/HEAD/docs/standards/repos/widgets.md)",
    );
  });

  it("degrades to plain text when no source resolves, rather than a dangling path", () => {
    const dir = makeTree(null);
    writeModule(dir, "See [the notes](repos/widgets.md).");
    const skill = generateSkills()["sb-widgets-standard"]["SKILL.md"];
    expect(skill).toContain("See the notes.");
    expect(skill).not.toContain("(repos/widgets.md)");
  });
});
