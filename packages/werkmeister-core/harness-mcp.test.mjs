// The generic MCP adapter (SW-188): a workspace with `harness: mcp` gets AGENTS.md
// and .agents/skills, nothing under .claude/, and hooks reported unavailable
// rather than silently absent.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { harnessLayoutFor, parseHarnessId } from "./dist/harness/layout.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";
import { initWorkspace } from "./dist/workspace_init.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();
process.env.WERKMEISTER_ROOT = path.join(import.meta.dirname, "..", "..", "apps", "cli");

test("parseHarnessId: blank is claude, an unknown id names the choices", () => {
  assert.equal(parseHarnessId(""), "claude");
  assert.equal(parseHarnessId(undefined), "claude");
  assert.equal(parseHarnessId("mcp"), "mcp");
  assert.equal(parseHarnessId("codex"), "codex");
  assert.throws(() => parseHarnessId("cursor"), /Unknown harness 'cursor'.*claude, mcp, codex/);
});

test("jit init on the mcp harness: AGENTS.md, .agents/skills, no .claude/, hooks reported unavailable", async () => {
  const std = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-std-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ws-"));
  try {
    fs.mkdirSync(path.join(std, "comments"));
    fs.writeFileSync(
      path.join(std, "comments", "STANDARD.md"),
      '---\ndomain: comments\nuniversal: 1\napplies_to:\n  - "**/*"\nphase: [implement]\nsummary: why\n---\n\n# Comments\n',
    );
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(
      path.join(root, ".werkmeister", "workspace.yml"),
      "task: Codex run\nwork_type: feature\ncontext_strategy: jit\nharness: mcp\n",
    );
    const reporter = collectingReporter();
    await withSandboxHome(() => withReporter(reporter, () => initWorkspace({}, root)), {
      config: `overrides:\n  standards_dir: ${std}\n`,
    });

    assert.equal(harnessLayoutFor(root).id, "mcp");
    const agentsMd = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agentsMd, /## Harness/);
    assert.match(agentsMd, /Hooks are unavailable on this harness/);
    assert.match(agentsMd, /http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")), "CLAUDE.md written");
    assert.ok(!fs.existsSync(path.join(root, ".claude")), ".claude/ written");
    const skills = fs.readdirSync(path.join(root, ".agents", "skills"));
    assert.ok(
      skills.some((s) => s.startsWith("w9r-")),
      `skills: ${skills}`,
    );
    const unavailable = reporter
      .text()
      .split("\n")
      .filter((l) => /hooks: unavailable on mcp/.test(l));
    assert.equal(unavailable.length, 1, reporter.text());
    assert.match(unavailable[0], /use harness: codex for Codex/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(std, { recursive: true, force: true });
  }
});
