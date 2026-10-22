import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDoc } from "./check-docs.mjs";

const ctx = {
  cli: { commands: new Map([["status", new Set(["--k8s", "--json"])]]) },
  tools: new Set(["status"]),
  exists: (p) => ["docs/real.md", "apps/cli/src/main.ts"].includes(p),
  read: () => "export function main() {}",
};
const check = (text) => checkDoc("docs/x.md", text, ctx);

test("flags retired terms unless the line opts out", () => {
  assert.equal(check("run k8s-connect").length, 1);
  assert.deepEqual(check("run k8s-connect <!-- docs-check: ignore -->"), []);
  assert.deepEqual(check("`pnpm run build`"), []);
});

test("flags broken relative links and missing repo paths, not pinned ones", () => {
  assert.deepEqual(check("[ok](real.md#a) [web](https://x.dev)"), []);
  assert.equal(check("[gone](gone.md)").length, 1);
  assert.equal(check("`apps/cli/src/gone.ts:12`").length, 1);
  assert.deepEqual(check("`apps/cli/src/main.ts::main`"), []);
  assert.equal(check("`apps/cli/src/main.ts::nope`").length, 1);
  assert.deepEqual(check("`docs/old.md` at 66703fc"), []);
});

test("checks commands and flags only where a command starts", () => {
  assert.deepEqual(check("`werkmeister status --k8s`"), []);
  assert.equal(check("`werkmeister k9s`").length, 1);
  assert.equal(check("`werkmeister status --all`").length, 1);
  assert.deepEqual(
    check("```\n# werkmeister never overwrites\ncd x && werkmeister status --json\n```"),
    [],
  );
  assert.deepEqual(check("`npm view werkmeister version`"), []);
});

test("checks MCP tool names", () => {
  assert.deepEqual(check("the `status` tool"), []);
  assert.equal(check("the `workspace-action` MCP tool").length, 1);
  assert.deepEqual(check("`mcp__cowork__create_artifact` tool"), []);
});
