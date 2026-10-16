// `optimize` compares observed usage against the limits in services.yaml, and
// the comparison is only as good as these two helpers. Getting a unit wrong by
// 1024x silently produces absurd recommendations, and a container name that
// fails to match its service silently reports "no limit set" for a service that
// has one — so both are pinned here, as the code actually behaves.

import assert from "node:assert/strict";
import { test } from "node:test";

import { matchService, parseConfigMem } from "./dist/stats.js";

test("parseConfigMem normalises the units services.yaml uses to MiB", () => {
  assert.equal(parseConfigMem("2G"), 2048);
  assert.equal(parseConfigMem("512M"), 512);
  assert.equal(parseConfigMem("2560M"), 2560);
  assert.equal(parseConfigMem("1024K"), 1);
  assert.equal(parseConfigMem(" 512M "), 512, "values come off YAML with whitespace");
  assert.equal(parseConfigMem("512"), 512, "a bare number is already MiB");
});

test("parseConfigMem reports nothing rather than NaN for what it cannot read", () => {
  assert.equal(parseConfigMem(""), 0);
  assert.equal(parseConfigMem("lots"), 0);
  // The ceiling: suffixes are matched case-sensitively, so a lowercase unit is
  // unreadable rather than assumed. services.yaml writes them uppercase.
  assert.equal(parseConfigMem("512m"), 0);
});

test("matchService finds the configured service inside a compose container name", () => {
  const configured = { backend: {}, frontend: {}, redis: {}, "k8s-forwards": {} };

  assert.equal(matchService("redis", configured), "redis", "a bare name matches itself");
  assert.equal(matchService("sandbox-redis", configured), "redis");
  assert.equal(matchService("feat-myfeature-frontend-1", configured), "frontend");
  assert.equal(matchService("sandbox-k8s-forwards", configured), "k8s-forwards");
  assert.equal(matchService("sandbox-demo-backend-1", configured), "backend");
});

test("matchService reports no match rather than guessing", () => {
  assert.equal(matchService("sandbox-demo-unknown-1", { backend: {} }), null);
  assert.equal(matchService("sandbox-jaeger", {}), null);
});
