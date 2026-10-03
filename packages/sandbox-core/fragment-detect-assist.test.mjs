// The Claude pass can only answer questions the deterministic pass asked, and
// only with values of the right shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { applyAnswers, assistPrompt, collectQuestions, planFragment, renderFragment } from "./dist/fragment_detect/index.js";
import { fixture, noTools } from "./fragment-detect-helpers.mjs";

const opts = (root) => ({ reposRoot: path.dirname(root), runner: noTools, localPath: "/nonexistent", portsPerSlot: 20 });

function goRepo(extra = {}) {
  const root = fixture({
    "package.json": { workspaces: ["services/*"] },
    "services/api/Dockerfile": "FROM golang:1.23\nEXPOSE 9000\nCMD [\"/app/api\"]\n",
    "services/web/package.json": { name: "web", scripts: { dev: "vite" }, dependencies: { vite: "5" } },
    "services/web/.env.example": "API_URL=\nSTRIPE_KEY=\n",
    "deploy/pay.yaml": "kind: Deployment\nmetadata: { name: payments }\nspec: { template: { spec: { containers: [ { name: c, image: 'pay:1', ports: [ { containerPort: 7000 } ] } ] } } }\n",
    ...extra,
  }, "shop");
  return planFragment(root, opts(root));
}

test("questions come only from guesses, env examples, siblings and unmatched resources", () => {
  const ids = collectQuestions(goRepo()).map((q) => q.id).sort();
  assert.deepEqual(ids, [
    "api.command",
    "api.depends_on",
    "api.health_endpoint",
    "unmatched.payments",
    "web.depends_on",
    "web.environment",
    "web.health_endpoint",
    "web.secrets",
  ]);
});

test("an accepted answer becomes an inferred value, rendered with its reason", () => {
  const plan = goRepo();
  const r = applyAnswers(plan, [
    { item: "api.command", value: "cd services/api && exec go run ./cmd/api", reason: "Makefile dev target", files_read: ["Makefile"] },
  ]);
  assert.deepEqual(r.accepted, ["api.command"]);
  assert.equal(r.plan.services.find((s) => s.name === "api").fields.command.confidence, "inferred");
  assert.match(renderFragment(r.plan).yaml, /command: cd services\/api && exec go run \.\/cmd\/api # inferred by Claude: Makefile dev target/);
  assert.equal(plan.services.find((s) => s.name === "api").fields.command.confidence, "guessed", "input plan untouched");
});

test("answers outside the questions, of the wrong shape, or repeated are rejected", () => {
  const r = applyAnswers(goRepo(), [
    { item: "web.command", value: "npm start", reason: "x", files_read: [] },
    { item: "api.health_endpoint", value: "healthz", reason: "x", files_read: [] },
    { item: "web.secrets", value: ["NOT_LISTED"], reason: "x", files_read: [] },
    { item: "api.depends_on", value: ["web"], reason: "calls it", files_read: [] },
    { item: "api.depends_on", value: [], reason: "again", files_read: [] },
  ]);
  assert.deepEqual(r.accepted, ["api.depends_on"]);
  assert.deepEqual(r.rejected.map((x) => x.item), ["web.command", "api.health_endpoint", "web.secrets", "api.depends_on"]);
});

test("an environment answer adds keys but never replaces a deterministic one", () => {
  const plan = goRepo({ "docker-compose.yml": "services:\n  web:\n    build: ./services/web\n    environment: { API_URL: http://api:9000 }\n" });
  const r = applyAnswers(plan, [
    { item: "web.environment", value: { API_URL: "http://wrong", MODE: "dev" }, reason: "README", files_read: [] },
  ]);
  const env = r.plan.services.find((s) => s.name === "web").fields.environment;
  assert.deepEqual(env.value, { API_URL: "http://api:9000", MODE: "dev" });
  assert.equal(env.confidence, "inferred");
});

test("an unmatched resource attached by Claude only adds fields the service lacks", () => {
  const r = applyAnswers(goRepo(), [{ item: "unmatched.payments", value: "api", reason: "same binary", files_read: [] }]);
  const api = r.plan.services.find((s) => s.name === "api");
  assert.equal(api.fields.internal_port.value, 9000, "Dockerfile port stays");
  assert.equal(api.fields.k8s_pod_prefix.value, "payments");
  assert.equal(api.fields.k8s_pod_prefix.confidence, "inferred");
  assert.equal(r.plan.unmatched.length, 0);
  assert.ok(!r.plan.skipped.some((s) => s.reason.includes("payments")));
});

test("no question for a field the existing file already sets", () => {
  const plan = goRepo({ ".sandbox/services.yaml": "services:\n  api:\n    command: make run\n" });
  assert.ok(!collectQuestions(plan).some((q) => q.id === "api.command"));
});

test("the prompt carries every question id and the read-only rules", () => {
  const qs = collectQuestions(goRepo());
  const prompt = assistPrompt(qs);
  for (const q of qs) assert.ok(prompt.includes(`"${q.id}"`));
  assert.match(prompt, /Leave a question out/);
  assert.match(prompt, /Never put credentials/);
});

test("one name defined in several unmatched files: one question, and one answer attaches them all", () => {
  const plan = goRepo({
    "deploy/pay-dev.yaml": "kind: Deployment\nmetadata: { name: payments, namespace: dev }\nspec: { template: { spec: { containers: [ { name: c, image: 'pay:1' } ] } } }\n",
  });
  assert.equal(plan.unmatched.length, 2);
  assert.deepEqual(collectQuestions(plan).filter((q) => q.kind === "unmatched").map((q) => q.id), ["unmatched.payments"]);
  const r = applyAnswers(plan, [{ item: "unmatched.payments", value: "api", reason: "same binary", files_read: [] }]);
  assert.deepEqual(r.accepted, ["unmatched.payments"]);
  assert.equal(r.plan.unmatched.length, 0);
  assert.equal(r.plan.services.find((s) => s.name === "api").findings.filter((f) => f.name === "payments").length, 2);
  assert.ok(!r.plan.skipped.some((s) => s.reason.includes("payments")));
});
