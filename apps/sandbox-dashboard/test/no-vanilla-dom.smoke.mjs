// SW-57 acceptance: no el() / injectCss() vanilla-DOM helper is left in the UI code.
// It lives here, outside the grep's own paths, so its pattern can't match itself.
// Source only: the CHANGELOG entry for SW-57 names the helpers it removed.
//   node test/no-vanilla-dom.smoke.mjs
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const grep = spawnSync(
  "grep",
  ["-rn", "injectCss\\|function el(", "packages/sandbox-ui/src", "apps/sandbox-dashboard/src"],
  { cwd: repo, encoding: "utf8" },
);
assert.equal(grep.status, 1, `vanilla-DOM helpers found:\n${grep.stdout}${grep.stderr}`);
console.log("no-vanilla-dom smoke: OK");
