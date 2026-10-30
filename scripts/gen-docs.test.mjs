import assert from "node:assert/strict";
import { test } from "node:test";
import { cliGuide, fill, mcpTools, roff, withMan } from "./gen-docs.mjs";

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

// SW-180: one help.md feeds --help, the guide and the man pages.
const cmd = (name, group, help) => ({
  name,
  group,
  usage: "[feature]",
  description: "Does it",
  options: [],
  help,
});

test("cliGuide groups commands and folds help.md's sections under each one", () => {
  const guide = cliGuide([
    cmd(
      "up",
      "Everyday:",
      "## Description\n\nStarts it.\n\n## Examples\n\n```bash\nwerkmeister up x\n```\n",
    ),
    cmd("setup", "Machine:", "## Description\n\nSets up.\n"),
  ]);
  assert.equal(
    guide,
    "### Everyday\n\n#### werkmeister up\n\nDoes it\n\n`werkmeister up [feature]`\n\nStarts it.\n\n**Examples**\n\n```bash\nwerkmeister up x\n```\n\n" +
      "### Machine\n\n#### werkmeister setup\n\nDoes it\n\n`werkmeister setup [feature]`\n\nSets up.",
  );
});

test("roff escapes what roff would eat and keeps code blocks verbatim", () => {
  assert.equal(
    roff("## Exit codes\n\nRun `a-b` [here](x.md).\n.dot \\ ok\n\n- one\n\n```\n.x --y\n```"),
    [
      ".SH EXIT CODES",
      ".PP",
      "Run \\fBa\\-b\\fR here. .dot \\e ok",
      ".IP \\(bu 3",
      "one",
      ".PP\n.nf\n.RS 4",
      "\\&.x \\-\\-y",
      ".RE\n.fi",
    ].join("\n"),
  );
});

test("withMan lists every page and leaves the rest of package.json alone", () => {
  const pkg = `${JSON.stringify({ name: "werkmeister", man: ["./man/gone.1"], files: [] }, null, 2)}\n`;
  assert.deepEqual(JSON.parse(withMan(pkg, { "werkmeister.1": "", "werkmeister-up.1": "" })), {
    name: "werkmeister",
    man: ["./man/werkmeister.1", "./man/werkmeister-up.1"],
    files: [],
  });
});
