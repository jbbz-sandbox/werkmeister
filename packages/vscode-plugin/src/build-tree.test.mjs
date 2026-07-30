import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, featureOf, interceptView } from "../out/build-tree.js";

const ws = (name, over = {}) => ({
  name,
  path: `/ws/${name}`,
  vscodeUri: `vscode://file/ws/${name}`,
  jiraId: null,
  jiraUrl: null,
  labels: [],
  ...over,
});

const st = (name, over = {}) => ({
  name,
  project: `sandbox-${name}`,
  state: "down",
  running: 0,
  total: 0,
  slot: null,
  ports: null,
  services: [],
  ...over,
});

/** An InterceptsResult-shaped object from a plain {feature: {service: row}} literal. */
const intercepts = (spec) => ({
  available: true,
  connectedNamespace: "default",
  byFeature: new Map(
    Object.entries(spec).map(([feat, svcs]) => [
      feat,
      new Map(
        Object.entries(svcs).map(([svc, over]) => [
          svc,
          {
            feature: feat,
            service: svc,
            deployment: svc,
            interceptable: true,
            blocker: null,
            intercepted: false,
            intercepted_by: null,
            ...over,
          },
        ]),
      ),
    ]),
  ),
});

test("featureOf strips the sandbox- compose prefix", () => {
  assert.equal(featureOf("sandbox-tre-1125"), "tre-1125");
  assert.equal(featureOf("something-else"), null);
  assert.equal(featureOf(null), null);
});

// serviceNode only looks up a row when feature is truthy, so interceptView never sees
// feature === null with a defined row under current code. This test guards against a
// future refactor of that ternary accidentally reintroducing a null-equals-null match.
test("a null feature with an intercepted row from an unknown source is not mine", () => {
  const result = interceptView({ intercepted: true, intercepted_by: null, blocker: null, interceptable: true }, null, false);
  assert.equal(result.contextValue, "service:intercepted-other");
  assert.equal(result.leave, false);
});

test("a fully running workspace reads as up", () => {
  const [node] = buildTree([ws("a")], [st("a", { state: "up", running: 6, total: 6, slot: 2 })], null, null);
  assert.equal(node.kind, "workspace");
  assert.equal(node.icon.id, "circle-filled");
  assert.match(node.description, /6\/6/);
  assert.match(node.description, /slot 2/);
  assert.equal(node.contextValue, "workspace:up");
});

test("a partially running workspace reads as partial", () => {
  const [node] = buildTree([ws("a")], [st("a", { state: "partial", running: 2, total: 5 })], null, null);
  assert.equal(node.contextValue, "workspace:partial");
  assert.match(node.description, /2\/5/);
});

test("a down workspace shows no ratio", () => {
  const [node] = buildTree([ws("a")], [st("a")], null, null);
  assert.equal(node.contextValue, "workspace:down");
  assert.match(node.description, /down/);
});

test("a Jira key appears in the description and the node carries its URL", () => {
  const [node] = buildTree(
    [ws("a", { jiraId: "TRE-1125", jiraUrl: "https://x/browse/TRE-1125" })],
    [st("a")],
    null,
    null,
  );
  assert.match(node.description, /TRE-1125/);
  assert.equal(node.workspace.jiraUrl, "https://x/browse/TRE-1125");
});

test("an interceptable service with no intercept offers the toggle", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 1, total: 1, services: [{ name: "next-hello", state: "healthy" }] })],
    intercepts({ a: { "next-hello": {} } }),
    null,
  );
  const [svc] = node.children;
  assert.equal(svc.kind, "service");
  assert.equal(svc.contextValue, "service:interceptable");
});

test("an intercept owned by this feature is mine", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 1, total: 1, services: [{ name: "next-hello", state: "healthy" }] })],
    intercepts({ a: { "next-hello": { intercepted: true, intercepted_by: "a" } } }),
    null,
  );
  assert.equal(node.children[0].contextValue, "service:intercepted-mine");
  assert.equal(node.children[0].service.leave, true);
});

// Only one intercept exists per Deployment; offering a --leave here would fail.
test("an intercept owned by another feature is not offered as mine", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 1, total: 1, services: [{ name: "next-hello", state: "healthy" }] })],
    intercepts({ a: { "next-hello": { intercepted: true, intercepted_by: "other" } } }),
    null,
  );
  const [svc] = node.children;
  assert.equal(svc.contextValue, "service:intercepted-other");
  assert.equal(svc.service.leave, false);
  assert.match(svc.tooltip, /other/);
});

test("a non-interceptable service surfaces the CLI blocker on hover", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 1, total: 1, services: [{ name: "postgres", state: "healthy" }] })],
    intercepts({ a: { postgres: { interceptable: false, blocker: "no k8s deployment" } } }),
    null,
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /no k8s deployment/);
});

// A failed lookup must not silently read as "nothing here is interceptable".
test("a null intercepts payload marks every service unavailable", () => {
  const [node] = buildTree(
    [ws("a")],
    [st("a", { state: "up", running: 1, total: 1, services: [{ name: "next-hello", state: "healthy" }] })],
    null,
    null,
  );
  assert.equal(node.children[0].contextValue, "service");
  assert.match(node.children[0].tooltip, /intercept state unavailable/);
});

test("the workspace containing the open folder is marked current and expanded", () => {
  const nodes = buildTree([ws("a"), ws("b")], [st("a"), st("b")], null, "/ws/b/trustradius");
  const b = nodes.find((n) => n.label === "b");
  assert.match(b.description, /current/);
  assert.equal(b.expanded, true);
  assert.equal(nodes.find((n) => n.label === "a").expanded, false);
});

// Two workspaces could both be ancestors if one nested inside the other.
test("when several workspaces match the open folder, the deepest wins", () => {
  const nodes = buildTree(
    [ws("outer", { path: "/ws" }), ws("inner", { path: "/ws/inner" })],
    [st("outer"), st("inner")],
    null,
    "/ws/inner/repo",
  );
  assert.match(nodes.find((n) => n.label === "inner").description, /current/);
  assert.doesNotMatch(nodes.find((n) => n.label === "outer").description, /current/);
});

// A path prefix is not an ancestor: /ws/abc must not match workspace /ws/ab.
test("a sibling with a shared name prefix is not treated as the current workspace", () => {
  const nodes = buildTree([ws("ab", { path: "/ws/ab" })], [st("ab")], null, "/ws/abc");
  assert.doesNotMatch(nodes[0].description, /current/);
});

test("a workspace missing from the status sweep renders as unknown", () => {
  const [node] = buildTree([ws("a")], [], null, null);
  assert.equal(node.contextValue, "workspace:unknown");
  assert.equal(node.icon.id, "question");
});

test("services are only listed when the status sweep found containers", () => {
  const [node] = buildTree([ws("a")], [st("a")], null, null);
  assert.deepEqual(node.children, []);
});

test("node ids are stable and unique", () => {
  const nodes = buildTree(
    [ws("a"), ws("b")],
    [
      st("a", { state: "up", running: 1, total: 1, services: [{ name: "svc", state: "healthy" }] }),
      st("b", { state: "up", running: 1, total: 1, services: [{ name: "svc", state: "healthy" }] }),
    ],
    null,
    null,
  );
  const ids = nodes.flatMap((n) => [n.id, ...n.children.map((c) => c.id)]);
  assert.equal(new Set(ids).size, ids.length);
});
