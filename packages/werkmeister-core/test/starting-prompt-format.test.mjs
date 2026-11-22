// The starting-prompt format both the refine tool and the issue extractor hand the model.

import assert from "node:assert/strict";
import { test } from "node:test";

const { buildRefinePrompt } = await import("../dist/sandbox.js");

// SW-996: the run may not read the real ~/.werkmeister, so a criterion that does cannot be checked.
test("the format never asks for a criterion that reads the real ~/.werkmeister (SW-996)", async () => {
  const prompt = await buildRefinePrompt("write metrics under ~/.werkmeister/metrics", "");
  assert.match(
    prompt,
    /Never write an acceptance criterion that reads or lists the real `~\/\.werkmeister` \(the run may not read it\); prove a write lands only under the test's temporary HOME with a test assertion \(the written path is under it\)\./,
  );
});
