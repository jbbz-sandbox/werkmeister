// markdownToWiki: `issue create` bodies and `issue update --comment` go to Jira
// REST v2, which stores wiki markup verbatim, so Markdown must be converted
// (SW-79 filed with `## Ask` rendered as a numbered list).

import assert from "node:assert/strict";
import { test } from "node:test";

const { markdownToWiki } = await import("./dist/issue_trackers/jira.js");

test("headings, lists and bold become wiki markup", () => {
  assert.equal(
    markdownToWiki("## Ask\n\n- **Flags.** one\n  - nested\n1. first\n2. second"),
    "h2. Ask\n\n* *Flags.* one\n** nested\n# first\n# second",
  );
});

test("code spans are monospace with wiki specials escaped", () => {
  assert.equal(
    markdownToWiki("Mark `<!-- generated:<name> -->` and `pr watch --install` and `{@link}`."),
    "Mark {{<\\!\\-\\- generated:<name> \\-\\->}} and {{pr watch \\-\\-install}} and {{\\{@link\\}}}.",
  );
});

test("fenced blocks become {code} and their contents stay untouched", () => {
  assert.equal(
    markdownToWiki("**Ran**\n```sh\n## not a heading\n- not a list\n```\nafter"),
    "*Ran*\n{code}\n## not a heading\n- not a list\n{code}\nafter",
  );
});

test("links become [text|url]", () => {
  assert.equal(
    markdownToWiki("See [SW-78](https://x/browse/SW-78)."),
    "See [SW-78|https://x/browse/SW-78].",
  );
});
