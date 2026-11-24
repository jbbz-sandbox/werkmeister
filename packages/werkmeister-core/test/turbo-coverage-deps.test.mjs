// SW-1130: a package's test:coverage must wait on what its test waits on. vscode's test needed
// werkmeister#build and test:coverage didn't, so CI's coverage job ran before the CLI was built.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import { parse } from "jsonc-parser";

const REPO = path.resolve(import.meta.dirname, "../../..");
const readJsonc = (file) => parse(fs.readFileSync(file, "utf8"));

/** The dependsOn turbo resolves for *task* in the package at *dir*: its own turbo.json, then the root's `name#task`, then the root's task. */
function dependsOn(root, local, name, task) {
  return (
    (local?.tasks?.[task] ?? root.tasks[`${name}#${task}`] ?? root.tasks[task])?.dependsOn ?? []
  );
}

test("each package's test:coverage depends on what its test does (SW-1130)", () => {
  const root = readJsonc(path.join(REPO, "turbo.json"));
  let checked = 0;
  for (const group of ["apps", "packages", "plugins"]) {
    for (const entry of fs.readdirSync(path.join(REPO, group))) {
      const dir = path.join(REPO, group, entry);
      const pkgFile = path.join(dir, "package.json");
      if (!fs.existsSync(pkgFile)) continue;
      const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
      if (!pkg.scripts?.["test:coverage"]) continue;
      const turbo = path.join(dir, "turbo.json");
      const local = fs.existsSync(turbo) ? readJsonc(turbo) : undefined;
      const deps = (task) => [...dependsOn(root, local, pkg.name, task)].sort();
      assert.deepEqual(deps("test:coverage"), deps("test"), `${group}/${entry} (${pkg.name})`);
      checked++;
    }
  }
  assert.ok(checked >= 3, `only ${checked} packages have a test:coverage script`);
});

test("the resolver sees a package override that changes test alone (SW-1130)", () => {
  const root = {
    tasks: { test: { dependsOn: ["build"] }, "test:coverage": { dependsOn: ["build"] } },
  };
  const local = { tasks: { test: { dependsOn: ["build", "werkmeister#build"] } } };
  assert.notDeepEqual(
    dependsOn(root, local, "x", "test:coverage"),
    dependsOn(root, local, "x", "test"),
  );
});
