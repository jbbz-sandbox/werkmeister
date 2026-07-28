import { test } from "node:test";
import assert from "node:assert/strict";
import { parseComposePs } from "./parse-compose.mjs";

test("NDJSON (newer compose) — health + ports", () => {
  const out = parseComposePs(
    '{"Service":"web","State":"running","Health":"healthy","Publishers":[{"PublishedPort":8080,"Protocol":"tcp"},{"PublishedPort":0}]}\n' +
      '{"Service":"db","State":"running","Health":"starting","Publishers":[{"PublishedPort":5432}]}\n',
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { service: "web", state: "running", health: "healthy", ports: [8080] });
  assert.equal(out[1].health, "starting");
  assert.deepEqual(out[1].ports, [5432]);
});

test("single JSON array (older compose)", () => {
  const out = parseComposePs('[{"Service":"api","State":"running","Publishers":null}]');
  assert.equal(out.length, 1);
  assert.equal(out[0].health, "running"); // no Health field, but running
  assert.deepEqual(out[0].ports, []);
});

test("health derives to down when not running and no health", () => {
  const out = parseComposePs('{"Service":"worker","State":"exited"}');
  assert.equal(out[0].health, "down");
});

test("unhealthy state passes through", () => {
  const out = parseComposePs('{"Service":"cache","State":"running","Health":"unhealthy"}');
  assert.equal(out[0].health, "unhealthy");
});

test("dedups + sorts published ports, drops 0", () => {
  const out = parseComposePs(
    '{"Service":"x","State":"running","Publishers":[{"PublishedPort":9000},{"PublishedPort":0},{"PublishedPort":8000},{"PublishedPort":9000}]}',
  );
  assert.deepEqual(out[0].ports, [8000, 9000]);
});

test("empty / junk → []", () => {
  assert.deepEqual(parseComposePs(""), []);
  assert.deepEqual(parseComposePs("   \n  "), []);
  assert.deepEqual(parseComposePs("not json\nalso not"), []);
});
