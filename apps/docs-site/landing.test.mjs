import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import config from "./.vitepress/config.mjs";

const ROOT = join(import.meta.dirname, "../..");
const landing = readFileSync(join(import.meta.dirname, "index.md"), "utf8");
const tagline = JSON.parse(landing.match(/^ {2}tagline: (".*")$/m)[1]);

test("the site description is the hero tagline", () => {
  assert.equal(config.description, tagline);
});

test("the hero tagline names the parts (SW-590)", () => {
  for (const part of [
    "Claude Code",
    "OpenCode",
    "Codex",
    "OCI",
    "git worktree",
    "Jira",
    "GitHub Issues",
  ]) {
    assert.ok(tagline.includes(part), part);
  }
});

test("each feature card ends with one concrete line", () => {
  const details = landing.match(/^ {4}details: .*$/gm);
  assert.equal(details.length, 3);
  for (const d of details) assert.match(d, /<br>/);
});

test("why.md has no note-to-self in § The name", () => {
  assert.doesNotMatch(readFileSync(join(ROOT, "docs/why.md"), "utf8"), /Not part of the story/);
});
