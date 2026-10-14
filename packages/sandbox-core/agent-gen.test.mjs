// Phase gates tools, archetype gates context (§5.4): the tester is the one
// generated artifact with Bash, so it owns the proxy smoke check; the
// researcher is the one that investigates, so it owns the method.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildResearcherAgent, buildTesterAgent, buildTesterSpecs } from "./dist/agent_gen.js";

const SERVICES = {
  frontend: { repo: "demo", archetype: "node-web" },
  worker: { repo: "demo", archetype: "node-web" },
};
const ARCHETYPES = { "node-web": { standards: ["ui"], test: "npm test" } };
const ROUTERS = { frontend: { hostname: "frontend.local.sandbox.com" } };

test("a routed service gets a smoke url, an unrouted one does not", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend", "worker"] }, SERVICES, ARCHETYPES, "test", ROUTERS, "/");
  const byName = Object.fromEntries(spec.services.map((s) => [s.name, s]));
  assert.equal(byName.frontend.url, "https://frontend.local.sandbox.com/");
  assert.equal(byName.worker.url, null);
  assert.equal(spec.feature, "test");
});

test("the tester body carries the guarded curl and no CLAUDE.md pointer", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES, "test", ROUTERS, "");
  const body = buildTesterAgent(spec);
  assert.match(body, /PROXY SMOKE CHECK/);
  assert.match(body, /docker ps --format '\{\{\.Names\}\}' \| grep -x test-frontend/);
  assert.match(body, /curl -sk -b "X-Feature=test" -o \/dev\/null -w "HTTP %\{http_code\}\\n" "https:\/\/frontend\.local\.sandbox\.com\/"/);
  assert.doesNotMatch(body, /read CLAUDE\.md first/);
  assert.match(body, /run from `demo\/`: `npm test`/, "the unit-test lines are unchanged");
});

test("no routed service means no smoke block and no throw", () => {
  const [spec] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES, "test", {}, "");
  assert.doesNotMatch(buildTesterAgent(spec), /PROXY SMOKE CHECK/);
  const [legacy] = buildTesterSpecs({ "node-web": ["frontend"] }, SERVICES, ARCHETYPES);
  assert.doesNotMatch(buildTesterAgent(legacy), /PROXY SMOKE CHECK/);
});

test("the researcher carries the investigation method, phrased for a subagent", () => {
  const body = buildResearcherAgent();
  for (const heading of [
    "Present options, don't pick",
    "Tag every non-trivial claim",
    "Anti-relitigation",
    "Bound the investigation",
    "named, not loaded",
    "Deliverable shape",
  ]) {
    assert.ok(body.includes(heading), heading);
  }
  assert.doesNotMatch(body, /AskUserQuestion/);
  assert.doesNotMatch(body, /read CLAUDE\.md first/);
  assert.match(body, /RETURN CONTRACT/);
});

test("a registered validate line sits under the test command; none adds nothing", () => {
  const svcs = { lib: { repo: "demo", archetype: "tool", validate: "run the smoke tests" }, bare: { repo: "demo", archetype: "tool" } };
  const archs = { tool: { standards: [], test: "npm test" } };
  const [spec] = buildTesterSpecs({ tool: ["bare", "lib"] }, svcs, archs, "test", {}, "");
  const body = buildTesterAgent(spec);
  assert.match(body, /- lib — run from `demo\/`: `npm test`\n  validate: run the smoke tests/);
  assert.doesNotMatch(body.split("- lib")[0], /validate:/, "bare service has no validate line");
});
