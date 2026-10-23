// featureFromVolume is the parser that decides what gets deleted. It is the one
// part of clean worth a unit test: a wrong answer removes someone's node_modules.
//
// The real naming scheme is `<feature>-<base>` — NOT `sandbox-<feature>-<base>`
// — so `foo-bar-node-modules` is feature `foo-bar`, base `node-modules`. There
// is no prefix to anchor on, which is exactly why the longest-first ordering of
// the base names is load-bearing rather than a tidiness rule.

import assert from "node:assert/strict";
import { test } from "node:test";

import { withSandboxHome } from "./fixtures.mjs";

const { classifyVolumes, featureFromVolume, volumeBaseNames } = await import("./dist/lifecycle.js");

test("featureFromVolume extracts the feature from a per-feature volume name", () => {
  assert.equal(featureFromVolume("foo-bar-node-modules", ["node-modules"]), "foo-bar");
});

test("featureFromVolume ignores a volume whose base name is not ours", () => {
  assert.equal(featureFromVolume("some-other-project-cache", ["node-modules"]), null);
});

test("longest-first base names keep the shorter suffix from eating the feature", async () => {
  // What volumeBaseNames() guarantees, and what a caller sorting them any other
  // way would break: "cache" also matches "demo-turbo-cache", leaving "demo-turbo".
  assert.equal(featureFromVolume("demo-turbo-cache", ["turbo-cache", "cache"]), "demo");
  assert.equal(featureFromVolume("demo-turbo-cache", ["cache", "turbo-cache"]), "demo-turbo");
  // Read through a seeded registry rather than the developer's: on a machine
  // without one this used to assert the ordering of an empty list.
  const bases = await withSandboxHome(async () => volumeBaseNames(), {
    services: `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    node_modules_volume: cache
    extra_volumes:
      - turbo-cache:/turbo
`,
  });
  assert.deepEqual(bases, ["turbo-cache", "cache"]);
});

// The classification is what `planClean` exists to get right, and the only part
// of the sweep that decides anything: everything around it is Docker reads and
// progress output. Asserted here directly rather than by calling `planClean`
// against the machine's real slot table, which meant the check ran only on a
// configured developer machine and asserted nothing at all on one with no
// features up.
test("a volume whose feature still holds a slot is kept, not orphaned", () => {
  const { activeVolumes, orphanedVolumes } = classifyVolumes(
    ["live-node-modules", "dead-node-modules"],
    ["node-modules"],
    new Set(["live"]),
  );
  assert.deepEqual(activeVolumes, ["live-node-modules"]);
  assert.deepEqual(orphanedVolumes, ["dead-node-modules"]);
});

test("a volume matching no base name is never kept as someone's active volume", () => {
  // It is not ours, so it has no feature -- and a volume with no feature must
  // not fall through into `activeVolumes` and look accounted for.
  const { activeVolumes, orphanedVolumes } = classifyVolumes(
    ["some-other-project-cache"],
    ["node-modules"],
    new Set(["some-other-project"]),
  );
  assert.deepEqual(activeVolumes, []);
  assert.deepEqual(orphanedVolumes, ["some-other-project-cache"]);
});

test("no live feature's volume is proposed for removal, whatever the ordering", () => {
  // The property the old integration test asserted, now without a daemon.
  const live = new Set(["demo", "demo-turbo"]);
  const bases = ["turbo-cache", "cache"];
  const { orphanedVolumes } = classifyVolumes(
    ["demo-cache", "demo-turbo-cache", "gone-cache"],
    bases,
    live,
  );
  for (const vol of orphanedVolumes) {
    const feature = featureFromVolume(vol, bases);
    assert.ok(!live.has(feature), `would delete live feature ${feature}`);
  }
  assert.deepEqual(orphanedVolumes, ["gone-cache"]);
});
