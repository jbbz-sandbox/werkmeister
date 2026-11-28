// SW-1093: a Should fix the exercise reaches is checked there before it is left.

import assert from "node:assert/strict";
import { test } from "node:test";
import { templateFor } from "../dist/strategies/icm_templates.js";

const vars = {
  at: (n) => `../${n}`,
  repos: "`../../repo/`",
  restart: "r",
  standards: "",
  autonomous: false,
  group: [],
};
const steps = (wt, name) =>
  templateFor(wt)
    .find((s) => s.name === name)
    .contract(vars)
    .process.join("\n");

test("every review step checks an exercisable Should fix in the exercise before leaving it", () => {
  for (const [wt, name] of [
    ["feature", "implement"],
    ["refactor", "implement"],
    ["bugfix", "exercise"],
  ]) {
    const c = steps(wt, name);
    assert.match(
      c,
      /Before leaving another \*\*Should fix\*\*, check it in the exercise when the exercise reaches the behaviour it describes \(a browser check, a CLI run\), and fix it when the exercise confirms it \(when the exercise step comes after this review, mark it `pending exercise` and settle it there, updating its `review\.md` row; a fix there takes the delta review\); leave it only when the exercise doesn't reach it or doesn't confirm it/,
      `${wt}/${name}`,
    );
    assert.doesNotMatch(c, /Leave the other \*\*Should fix\*\*/, `${wt}/${name}`);
  }
});
