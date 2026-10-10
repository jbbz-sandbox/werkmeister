// CLAUDE.md is the always-on file, so everything it carries is paid on every
// turn. These pin what left it: the Feature Testing section, the service-map
// column, the duplicated phase-entry paragraph, the 'do not load' line.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildClaudeMd, buildRoutingTable, buildStandardsRoutingSection } from "./dist/claude_md.js";

// `universal: <n>` is what the loader stamps on UNIVERSAL_STANDARDS modules.
const MODULES = {
  comments: { summary: "why not what", applies_to: ["**/*"], universal: 0 },
  engineering: { summary: "constraints", applies_to: ["**/*"], universal: 1 },
  ui: { summary: "ui rules", applies_to: ["**/*.tsx"] },
};

function withDir(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "claude-md-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("the standards section states the phase chain once, with no inactive list", () => {
  const out = buildStandardsRoutingSection(["comments", "engineering", "ui"], MODULES, ["demo"]);
  assert.match(out, /\| ui \| `sb-ui-standard` \| `\*\*\/\*\.tsx` \|/);
  assert.doesNotMatch(out, /Not active/);
  assert.doesNotMatch(out, /\*\*Phase entry:\*\*/);
  assert.doesNotMatch(out, /workspace root/);
  assert.equal((out.match(/`sb-implement`/g) ?? []).length, 1);
  assert.match(out, /\| Phase \| Invoke first \| Loads \|/);
  assert.match(out, /universal base \(`ponytail` \+ `sb-comments-standard` \+ `sb-engineering-standard`\)/);
});

test("the routing table is two columns: one feature row, contract row only for multi-repo", () => {
  withDir((ws) => {
    fs.mkdirSync(path.join(ws, "a"));
    fs.writeFileSync(path.join(ws, "a", "CLAUDE.md"), "# a\n");
    const single = buildRoutingTable([["a", "u/x"]], ws, true);
    assert.equal(single.split("\n")[0], "| Task | Read |");
    assert.match(single, /\| Working in a \| a\/CLAUDE\.md \|/);
    assert.match(single, /\| Running or validating the change[^|]*\| \.sandbox\/sandbox-context\.md \|/);
    assert.doesNotMatch(single, /Cross-repo/);
    assert.doesNotMatch(single, /service-map/);
    const multi = buildRoutingTable([["a", "u/x"], ["b", "u/x"]], ws, false);
    assert.match(multi, /\| Cross-repo contract change \| \.sandbox\/notes\/ \(`contract` notes\) \|/);
    assert.doesNotMatch(multi, /Working in b/, "no row for a repo CLAUDE.md that does not exist");
  });
});

test("CLAUDE.md carries no Feature Testing section", () => {
  withDir((ws) => {
    const out = buildClaudeMd(
      "test",
      ws,
      [["demo", "u/test"]],
      "Task",
      { FEATURE: "test", SERVICES: "frontend", TEST_PATH: "/" },
      "## Standards routing\n\n(stub)\n",
    );
    assert.doesNotMatch(out, /## Feature Testing/);
    assert.doesNotMatch(out, /document\.cookie/, "the cookie one-liner lives in sandbox-context.md now");
    assert.match(out, /Running or validating the change — test commands/, "the routing row still points at it");
    assert.match(out, /## Notes/);
    assert.match(out, /## Standards routing/);
    assert.doesNotMatch(out, /`finding`.*`decision`/s, "the Notes section no longer enumerates the types inline");
    assert.match(out, /notes-conventions\.md/, "the Notes section still points at the conventions doc");
  });
});

const ACTIVE = ["comments", "engineering", "ui"];
const section = (workType) => buildStandardsRoutingSection(ACTIVE, MODULES, ["demo"], workType);
const byPhase = (out) => out.slice(out.indexOf("**By phase**"));

test("refactor has no research row and no note gate", () => {
  const out = section("refactor");
  assert.doesNotMatch(byPhase(out), /`sb-research`/);
  assert.match(out, /\*\*Work type:\*\* refactor \(bounded path\) — phases: implement → test → review → pr\./);
  assert.doesNotMatch(out, /Gate:[^\n]*note/);
});

test("spike has no implement, review, or PR row", () => {
  const out = byPhase(section("spike"));
  assert.doesNotMatch(out, /`sb-implement`|`sb-review`|`sb-pr`/);
  assert.match(section("spike"), /Anything built is throwaway/);
});

test("feature names the decided gate; bugfix names the root cause", () => {
  assert.match(section("feature"), /`decision` note in `\.sandbox\/notes\/` reads `status: decided`/);
  assert.match(section("bugfix"), /`finding` note in `\.sandbox\/notes\/` names the root cause/);
  assert.doesNotMatch(byPhase(section("bugfix")), /^\| review \(/m, "the pr row still names sb-review; the review row is gone");
});

test("the active table is identical across work types", () => {
  const active = (out) => out.slice(0, out.indexOf("**By phase**"));
  const strip = (out) => active(out).replace(/\*\*Work type:\*\*[^\n]*\n[^\n]*\n\n/, "");
  for (const wt of ["feature", "bugfix", "refactor", "spike", "incident"]) {
    assert.equal(strip(section(wt)), active(section("")), wt);
  }
});

test("an empty or unknown work type renders today's section exactly", () => {
  const today = buildStandardsRoutingSection(ACTIVE, MODULES, ["demo"]);
  assert.equal(section(""), today);
  assert.equal(section("chore"), today);
  assert.doesNotMatch(today, /Work type/);
  assert.equal((byPhase(today).match(/^\| [^|]+ \| `sb-/gm) ?? []).length, 5);
});

test("an issue replaces the inline link with the issue section", () => {
  const issue = { ref: "o/r#5", url: "https://github.com/o/r/issues/5", title: "Stale config", fetchedAt: "2026-10-11T18:04:00.000Z" };
  const md = buildClaudeMd("ws", "/ws", [], "Fix it", { ISSUE_ID: "o/r#5" }, null, issue);
  assert.match(md, /## Current Task\n\nFix it\n\n/);
  assert.match(md, /## Issue\n\n\[o\/r#5\]\(https:\/\/github.com\/o\/r\/issues\/5\): Stale config\./);
});
