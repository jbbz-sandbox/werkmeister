import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleProblems, jiraKeyProblems } from "../typedoc-require-example.mjs";

const ok = { id: "functions/up", hasExample: true };
const bare = { id: "functions/down", hasExample: false };

test("exampleProblems passes when every export has an @example", () => {
  assert.deepEqual(exampleProblems([ok]), []);
});

test("exampleProblems names an export with no @example", () => {
  assert.deepEqual(exampleProblems([ok, bare]), [
    "functions/down: SDK export has no @example importing werkmeister-core/sdk",
  ]);
});

// SW-883: docs-site renders these comments into SDK pages, so a Jira key here must fail docs:sdk in the lint row.
test("jiraKeyProblems names a Jira key in an SDK comment's prose", () => {
  const text = "Skip the no-slot banner: `workspace new` prints its own next step (SW-663).";
  assert.deepEqual(
    jiraKeyProblems([
      { id: "interfaces/InitWorkspaceOptions.quietNoSlot", text },
      { id: "functions/up", text: "Starts it; see `SW-12` and [SW-13](https://x/SW-13)." },
    ]),
    [
      `interfaces/InitWorkspaceOptions.quietNoSlot: Jira key SW-663 in an SDK comment; readers can't open the tracker`,
    ],
  );
});
