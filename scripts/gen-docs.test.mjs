import assert from "node:assert/strict";
import { test } from "node:test";
import { fill, mcpTools } from "./gen-docs.mjs";

test("fill rewrites each region's body and nothing else, idempotently", () => {
  const once = fill("a\n<!-- generated:x -->\nold\n<!-- /generated -->\nb", { x: "| t |" }).text;
  assert.equal(once, "a\n<!-- generated:x -->\n\n| t |\n\n<!-- /generated -->\nb");
  assert.equal(fill(once, { x: "| t |" }).text, once);
});

test("fill reports an unknown region and an unclosed marker", () => {
  const { problems } = fill("<!-- generated:x -->\n<!-- generated:y -->\n<!-- /generated -->", {
    x: "",
    y: "",
  });
  assert.deepEqual(problems, [
    { line: 1, msg: "generated region `x` has no `<!-- /generated -->`" },
  ]);
  assert.deepEqual(fill("<!-- generated:z --><!-- /generated -->", {}).problems, [
    { line: 1, msg: "unknown generated region `z`" },
  ]);
});

test("mcpTools reads name, title and UI-only from each registration", () => {
  const src = `
    server.registerTool(
      "up",
      { title: "Bring a feature up", inputSchema: {} },
    );
    registerAppTool(server, "issue-statuses", {
      title: "Issue Statuses",
      _meta: APP_ONLY,
    });`;
  assert.deepEqual(mcpTools(src), [
    { name: "up", title: "Bring a feature up", app: false },
    { name: "issue-statuses", title: "Issue Statuses", app: true },
  ]);
});
