// SW-495: the check-in and chat approval notes live in one place (APPROVAL_NOTE);
// every copy a person or agent reads must spell them the same, or a relayed
// approval is written in a form the contract or graduation doesn't accept.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { APPROVAL_NOTE, CHAT_APPROVAL } from "./dist/pr_rules.js";

const REPO = path.resolve(import.meta.dirname, "../..");
const COPIES = {
  "apps/cli/infra/skills/w9r-pr/SKILL.md": ["chatPr", "checkInPr"],
  "docs/workspace-lifecycle.md": ["chatPr", "checkInPr"],
  "plugins/werkmeister/skills/check-in/SKILL.md": ["checkIn", "checkInPr"],
};
const FORMS = Object.values(APPROVAL_NOTE);
const NOTE = /approved (?:in chat|via check-in)[^)`\n]*/g;

test("every copy holds the note forms it needs", () => {
  for (const [file, keys] of Object.entries(COPIES)) {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    for (const k of keys)
      assert.ok(text.includes(APPROVAL_NOTE[k]), `${file}: ${APPROVAL_NOTE[k]}`);
  }
  for (const k of ["chat", "checkIn", "chatPr"])
    assert.ok(CHAT_APPROVAL.includes(APPROVAL_NOTE[k]), k);
});

test("no copy spells a note any other way", () => {
  for (const file of Object.keys(COPIES)) {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    for (const [note] of text.matchAll(NOTE))
      assert.ok(
        FORMS.some((f) => f.includes(note)),
        `${file}: "${note}" is not one of APPROVAL_NOTE`,
      );
  }
});
