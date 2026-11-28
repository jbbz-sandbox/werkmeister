// SW-1146: a correctness or security Should fix is put to the person, never left in silence.

import assert from "node:assert/strict";
import { test } from "node:test";
import { templateFor } from "../dist/strategies/icm_templates.js";

const steps = (wt, name, questionTool) =>
  templateFor(wt)
    .find((s) => s.name === name)
    .contract({
      at: (n) => `../${n}`,
      repos: "`../../repo/`",
      restart: "r",
      standards: "",
      autonomous: false,
      group: [],
      questionTool,
    })
    .process.join("\n");

const ASK =
  /A \*\*Should fix\*\* that is a correctness or security defect in this change's own code is never left without asking: before `review\.md`'s status flips, ask the person about each one \(fix now \/ file a ticket \/ leave\), (.+?), and record the answer beside the finding\./;

test("every review step asks the person about each correctness or security Should fix", () => {
  for (const [wt, name] of [
    ["feature", "implement"],
    ["refactor", "implement"],
    ["bugfix", "exercise"],
  ]) {
    assert.equal(
      steps(wt, name, "AskUserQuestion").match(ASK)?.[1],
      "through `AskUserQuestion`",
      `${wt}/${name}`,
    );
    assert.equal(
      steps(wt, name).match(ASK)?.[1],
      "as one numbered block at the end of your reply",
      `${wt}/${name}`,
    );
  }
});
