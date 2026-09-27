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
    assert.match(single, /\| Running the feature[^|]*\| \.sandbox\/sandbox-context\.md \|/);
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
    assert.match(out, /Running the feature — URL, X-Feature cookie/, "the routing row still points at it");
    assert.match(out, /## Notes/);
    assert.match(out, /## Standards routing/);
  });
});
