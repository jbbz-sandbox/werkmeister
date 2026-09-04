// featureFromVolume is the parser that decides what gets deleted. It is the one
// part of clean worth a unit test: a wrong answer removes someone's node_modules.
//
// The real naming scheme is `<feature>-<base>` — NOT `sandbox-<feature>-<base>`
// — so `foo-bar-node-modules` is feature `foo-bar`, base `node-modules`. There
// is no prefix to anchor on, which is exactly why the longest-first ordering of
// the base names is load-bearing rather than a tidiness rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

// Pinned before `lifecycle` loads: planClean reads this checkout's registry,
// and a shell exporting SANDBOX_ROOT (`~/.sandbox/env.sh` does) would otherwise
// point it at whichever checkout that names.
process.env.SANDBOX_ROOT = path.join(import.meta.dirname, "..", "..", "apps", "cli");

const { featureFromVolume, planClean, volumeBaseNames } = await import("./dist/lifecycle.js");

test("featureFromVolume extracts the feature from a per-feature volume name", () => {
  assert.equal(featureFromVolume("foo-bar-node-modules", ["node-modules"]), "foo-bar");
});

test("featureFromVolume ignores a volume whose base name is not ours", () => {
  assert.equal(featureFromVolume("some-other-project-cache", ["node-modules"]), null);
});

test("longest-first base names keep the shorter suffix from eating the feature", () => {
  // What volumeBaseNames() guarantees, and what a caller sorting them any other
  // way would break: "cache" also matches "demo-turbo-cache", leaving "demo-turbo".
  assert.equal(featureFromVolume("demo-turbo-cache", ["turbo-cache", "cache"]), "demo");
  assert.equal(featureFromVolume("demo-turbo-cache", ["cache", "turbo-cache"]), "demo-turbo");
  const bases = volumeBaseNames();
  assert.deepEqual(bases, [...bases].sort((a, b) => b.length - a.length || a.localeCompare(b)));
});

test("planClean never proposes removing a volume for a feature holding a slot", async () => {
  const plan = await planClean();
  const { getAllSlots } = await import("./dist/slots.js");
  const live = Object.keys(await getAllSlots());
  const bases = volumeBaseNames();
  for (const vol of plan.orphanedVolumes) {
    const feature = featureFromVolume(vol, bases);
    if (feature) assert.ok(!live.includes(feature), `would delete live feature ${feature}`);
  }
  // And the live ones are accounted for rather than merely absent.
  for (const vol of plan.activeVolumes) {
    assert.ok(live.includes(featureFromVolume(vol, bases)), `kept ${vol} for a dead feature`);
  }
});
