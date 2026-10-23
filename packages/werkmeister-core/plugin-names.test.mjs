// The plugin's names agree across the manifests, the skill dirs and the MCP wiring (SW-9).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const REPO = path.resolve(import.meta.dirname, "../..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(REPO, ...p), "utf8"));

test("the marketplace lists a plugin that exists under the name its manifest declares", () => {
  const marketplace = readJson(".claude-plugin/marketplace.json");
  for (const entry of marketplace.plugins) {
    const dir = path.join(REPO, entry.source);
    const manifest = readJson(path.relative(REPO, dir), ".claude-plugin/plugin.json");
    assert.equal(manifest.name, entry.name, entry.source);
  }
});

test("every skill dir is named by its frontmatter", () => {
  const skills = path.join(REPO, "plugins/werkmeister/skills");
  for (const dir of fs.readdirSync(skills)) {
    const text = fs.readFileSync(path.join(skills, dir, "SKILL.md"), "utf8");
    assert.match(text, new RegExp(`^name: ${dir}$`, "m"), dir);
  }
});

test("the plugin's MCP server is the one the code and the permission rules name", () => {
  const servers = Object.keys(readJson("plugins/werkmeister/.mcp.json").mcpServers);
  assert.deepEqual(servers, ["werkmeister"]);
});

test("the old plugin path is a link to the new one, for CLAUDE_CODE_PLUGIN_DIRS installs", () => {
  const old = path.join(REPO, "plugins/sandbox-tools");
  assert.equal(fs.readlinkSync(old), "werkmeister");
  assert.equal(readJson("plugins/sandbox-tools/.claude-plugin/plugin.json").name, "werkmeister");
});
