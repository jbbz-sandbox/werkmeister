// SW-35/SW-181: builds stay one at a time until turbo's pid-named temp files
// stop colliding across identical containers.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

test("the install script takes the single turbo-build lock", () => {
  const script = fs.readFileSync(
    new URL("../../apps/cli/infra/compose/scripts/werkmeister-install-startup.sh", import.meta.url),
    "utf8",
  );
  assert.equal(script.match(/flock "\$LOCKS\/turbo-build"/g)?.length, 1);
});
