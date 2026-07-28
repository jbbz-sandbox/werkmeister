import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePr } from "./parse-pr.mjs";

test("gh pr view object", () => {
  const out = parsePr(
    '{"state":"OPEN","url":"https://github.com/o/r/pull/7","title":"Add thing","number":7}',
  );
  assert.deepEqual(out, {
    state: "OPEN",
    url: "https://github.com/o/r/pull/7",
    title: "Add thing",
    number: 7,
  });
});

test("gh pr list array — takes first", () => {
  const out = parsePr('[{"state":"merged","url":"https://x/1","title":"t","number":1}]');
  assert.equal(out.state, "MERGED");
  assert.equal(out.number, 1);
});

test("unrecognized state → null state, pr still returned", () => {
  const out = parsePr('{"state":"DRAFT","url":"https://x/2","number":2}');
  assert.equal(out.state, null);
  assert.equal(out.url, "https://x/2");
  assert.equal(out.title, "");
});

test("no url → null (nothing to link)", () => {
  assert.equal(parsePr('{"state":"OPEN","number":3}'), null);
});

test("empty / no PR / bad json → null", () => {
  assert.equal(parsePr(""), null);
  assert.equal(parsePr("no pull requests found"), null);
  assert.equal(parsePr("[]"), null);
});
