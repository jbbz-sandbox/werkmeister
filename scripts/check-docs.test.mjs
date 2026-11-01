import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkDoc, checkMan, isIgnored, listFiles, slug } from "./check-docs.mjs";

const ctx = {
  cli: {
    commands: new Map([
      ["status", new Set(["--k8s", "--json"])],
      ["feature status", new Set(["--json"])],
      ["infra status", new Set(["--json"])],
      ["workspace new", new Set()],
      ["feature down", new Set(["--volumes"])],
      ["pr watch", new Set(["--install", "--json"])],
      ["pr adopt", new Set(["--no-pr", "--json"])],
    ]),
  },
  tools: new Set(["status"]),
  regions: { x: "a" },
  exists: (p) => ["docs/real.md", "apps/cli/src/main.ts"].includes(p),
  read: (p) => (p === "docs/real.md" ? "## A" : "export function main() {}"),
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
  assert.deepEqual(check("`werkmeister infra status`"), []);
  assert.equal(check("`werkmeister k9s`").length, 1);
  assert.equal(check("`werkmeister feature status --all`").length, 1);
  assert.deepEqual(
    check("```\n# werkmeister never overwrites\ncd x && werkmeister feature status --json\n```"),
    [],
  );
  assert.deepEqual(check("`npm view werkmeister version`"), []);
});

test("a noun's verb is its own command, and a pre-SW-186 spelling is retired", () => {
  assert.equal(check("`werkmeister feature status --k8s`").length, 1);
  assert.match(
    check("`werkmeister status --k8s`")[0],
    /retired `werkmeister status` — use .*`infra status`/,
  );
  assert.match(check("`w9r up feat`")[0], /werkmeister feature up/);
  assert.deepEqual(check("the werkmeister status of a run"), []);
  assert.deepEqual(check("`Bash(werkmeister feature status:*)` and `w9r ws new`"), []);
});

test("checks MCP tool names", () => {
  assert.deepEqual(check("the `status` tool"), []);
  assert.equal(check("the `workspace-action` MCP tool").length, 1);
  assert.deepEqual(check("`mcp__werkmeister__status` tool"), []);
});

test("checks flags anywhere in a command, up to a bare --", () => {
  assert.deepEqual(check("`werkmeister feature down my-feature --volumes`"), []);
  assert.deepEqual(check("`werkmeister pr watch --install`"), []);
  assert.deepEqual(check("`werkmeister feature down x -- --nope`"), []);
  assert.deepEqual(check('`werkmeister pr adopt --no-pr "a --b"`'), []);
  assert.equal(check("`werkmeister feature down my-feature --nope`").length, 1);
  assert.equal(check("`werkmeister pr watch --all`").length, 1);
});

test("checks w9r <cmd> lines like werkmeister ones", () => {
  assert.deepEqual(check("`w9r infra status`"), []);
  assert.deepEqual(check("`cd sandbox && werkmeister feature status`"), []);
  assert.equal(check("`w9r feature status --all`").length, 1);
  assert.equal(check("`w9r k9s`").length, 1);
});

test("flags bare placeholders outside code", () => {
  assert.deepEqual(check("`<url>` and \\<url>"), []);
  assert.deepEqual(check("<details><summary>x</summary></details> <https://x.dev>"), []);
  assert.deepEqual(check("a `wrapped\n<url>` span"), []);
  assert.deepEqual(check("---\ndescription: on a <user> branch\n---\n# x"), []);
  assert.deepEqual(check("```\ncurl <url>\n```"), []);
  assert.equal(check("PR <url> merged").length, 1);
  assert.equal(check('posts "Abandoned: <reason>"').length, 1);
});

test("checks #anchors against GitHub heading slugs", () => {
  assert.deepEqual(check("# Real heading\n[x](#real-heading)"), []);
  assert.deepEqual(check("# A\n# A\n[x](#a-1)"), []);
  assert.deepEqual(check("[x](real.md#a) [y](../apps/cli/src/main.ts#L9)"), []);
  assert.equal(check("[x](#gone)").length, 1);
  assert.equal(check("[x](real.md#nope)").length, 1);
  assert.equal(slug("k8s Port-Forwards (Containerized)"), "k8s-port-forwards-containerized");
  assert.equal(slug("Features & Workspaces"), "features--workspaces");
  assert.equal(slug("`werkmeister connect --k8s`"), "werkmeister-connect---k8s");
});

test("fails a generated region that docs:gen would rewrite", () => {
  const fresh = "<!-- generated:x -->\n\na\n\n<!-- /generated -->";
  assert.deepEqual(check(`# T\n${fresh}`), []);
  assert.match(
    check(fresh.replace("\na\n", "\nb\n"))[0],
    /x\.md:1: generated region `x` is out of date/,
  );
  assert.match(
    check("<!-- generated:y -->\n<!-- /generated -->")[0],
    /unknown generated region `y`/,
  );
  // Stale, but not retired: a generated line restates its source.
  assert.equal(
    check("<!-- generated:x -->\n\nnpm run k8s-connect\n\n<!-- /generated -->").length,
    1,
  );
});

test("a gitignored directory counts as ignored even when it was never built", () => {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "dist/\n");
  assert.equal(isIgnored("apps/web/dist", root), true);
  assert.equal(isIgnored("apps/web/src", root), false);
});

test("checkMan flags a stale, a missing and an orphaned man page", () => {
  const dir = mkdtempSync(join(tmpdir(), "man-"));
  writeFileSync(join(dir, "werkmeister.1"), "old\n");
  writeFileSync(join(dir, "werkmeister-gone.1"), "x\n");
  const problems = checkMan({ "werkmeister.1": "new\n", "werkmeister-up.1": "up\n" }, dir);
  assert.deepEqual(
    problems.map((p) => p.replace(/^.*\//, "")),
    [
      "werkmeister.1: out of date, run `pnpm run docs:gen`",
      "werkmeister-up.1: out of date, run `pnpm run docs:gen`",
      "werkmeister-gone.1: no such command, run `pnpm run docs:gen`",
    ],
  );
  assert.deepEqual(checkMan({ "werkmeister.1": "old\n", "werkmeister-gone.1": "x\n" }, dir), []);
});

test("listFiles includes untracked files and skips gitignored ones", () => {
  const root = mkdtempSync(join(tmpdir(), "check-docs-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), "ign.md\n");
  for (const f of ["tracked.md", "new.md", "ign.md"]) writeFileSync(join(root, f), "# T\n");
  execFileSync("git", ["add", "tracked.md"], { cwd: root });
  assert.deepEqual(listFiles(root).sort(), [".gitignore", "new.md", "tracked.md"]);
});
