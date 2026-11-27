import assert from "node:assert/strict";
import { test } from "node:test";
import { internalRefProblems } from "../typedoc-require-example.mjs";

// SW-947: docs-site's SDK test bans these only after a full build; docs:sdk must fail on them in lint.
test("internalRefProblems names each reference the docs-site SDK test bans", () => {
  const texts = [
    "The session, as #236 added it.",
    "Cite it as note 003 says.",
    "Reads `werkmeister-core/config` directly.",
    "Wired in main.ts.",
    "See proposal § 4.3.",
  ];
  assert.deepEqual(
    internalRefProblems(texts.map((text, i) => ({ id: `functions/f${i}`, text }))).map(
      (p) => p.split(":")[0],
    ),
    texts.map((_, i) => `functions/f${i}`),
  );
  assert.equal(
    internalRefProblems([{ id: "interfaces/Deps.session", text: "Set by #236." }])[0],
    `interfaces/Deps.session: internal reference "#236" in an SDK comment; SDK readers can't follow it`,
  );
});

test("internalRefProblems passes the SDK entry, a bare # and a source path", () => {
  const texts = [
    'import { up } from "werkmeister-core/sdk";',
    "The issue # comes from the tracker.",
    "Defined in packages/werkmeister-core/src/sdk.ts.",
  ];
  assert.deepEqual(internalRefProblems(texts.map((text) => ({ id: "functions/up", text }))), []);
});
