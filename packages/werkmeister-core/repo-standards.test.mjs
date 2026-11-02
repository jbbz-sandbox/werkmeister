// A repo's own standards (<repo>/.werkmeister/standards/) load on top of the
// global tree, only in workspaces that check the repo out.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { generateSkills } from "./dist/skill_gen.js";
import { checkStandards, loadStandardsModules, resolveActiveStandards } from "./dist/standards.js";
import { writeWorkspaceSkills } from "./dist/workspace_skills.js";
import { pinWerkmeisterRoot } from "./fixtures.mjs";

pinWerkmeisterRoot();

const mod = (domain, extra = "") =>
  `---\ndomain: ${domain}\nsummary: ${domain} rules\napplies_to:\n  - '**/*.ts'\n${extra}---\n\n# ${domain}\n`;

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

/** A global tree with `comments` (universal) and `config`, and a repo `fhir` with its own tree. */
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-standards-"));
  const global = write(path.join(tmp, "standards"), {
    "comments.md": mod("comments", "universal: 1\n"),
    "config/STANDARD.md": mod("config"),
  });
  const repo = write(path.join(tmp, "repos", "fhir"), {
    ".werkmeister/standards/smart/STANDARD.md": mod("smart"),
    // Clashes with the global tree's domain; the global one must win.
    ".werkmeister/standards/config.md": mod("config"),
  });
  execFileSync("git", ["init", "-q", repo]);
  return { tmp, global, repo };
}

function withConfig(tmp, global, fn) {
  const cfg = path.join(tmp, "config.yaml");
  fs.writeFileSync(
    cfg,
    `version: 1\npaths:\n  repos_root: ${path.join(tmp, "repos")}\noverrides:\n  standards_dir: ${global}\n`,
  );
  fs.writeFileSync(path.join(tmp, "services.yaml"), "services:\n  demo:\n    type: api\n");
  const prev = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = cfg;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = prev;
  }
}

test("a repo's modules merge in tagged with the repo; the global tree wins a clash", () => {
  const { global, repo } = fixture();
  assert.deepEqual(Object.keys(loadStandardsModules(global)).sort(), ["comments", "config"]);
  const modules = loadStandardsModules(global, [repo]);
  assert.deepEqual(Object.keys(modules).sort(), ["comments", "config", "smart"]);
  assert.equal(modules.smart.repo, "fhir");
  assert.equal(modules.smart.root, path.join(repo, ".werkmeister", "standards"));
  assert.equal(modules.config.repo, undefined);
  assert.equal(modules.config.root, global);
});

test("a repo's modules are active in its workspace, and standards_override.remove still drops one", () => {
  const { global, repo } = fixture();
  const modules = loadStandardsModules(global, [repo]);
  const resolve = (wc) => resolveActiveStandards(["fhir"], {}, {}, wc, modules, [], {});
  assert.deepEqual(resolve({}), [["comments", "smart"], ["config"]]);
  assert.deepEqual(resolve({ standards_override: { remove: ["smart"] } }), [
    ["comments"],
    ["config", "smart"],
  ]);
});

test("standards check covers repo trees under repos_root and reports a domain clash", () => {
  const { tmp, global, repo } = fixture();
  write(repo, { ".werkmeister/standards/bad.md": "---\nsummary: no domain\n---\n" });
  const result = withConfig(tmp, global, checkStandards);
  assert.deepEqual(result.repoTrees, [path.join(repo, ".werkmeister", "standards")]);
  assert.equal(result.moduleCount, 3, "comments, config and smart");
  assert.deepEqual(result.errors, [
    "fhir: bad.md: unparseable frontmatter or missing `domain:`",
    `fhir: \`config\` is also a module in ${global}, which wins; rename this one`,
  ]);
});

test("a repo module's generated skill links to that repo, not the global tree", () => {
  const { global, repo } = fixture();
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:org/fhir.git"]);
  const skills = generateSkills(null, loadStandardsModules(global, [repo]));
  assert.match(
    skills["w9r-smart-standard"]["SKILL.md"],
    /Source: {4}https:\/\/github\.com\/org\/fhir\/blob\/HEAD\/\.werkmeister\/standards\/smart\/STANDARD\.md/,
  );
});

test("a workspace projects the skills of the repos it checks out", () => {
  const { tmp, global, repo } = fixture();
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws);
  const noEntrySkills = path.join(tmp, "no-entry-skills");
  const project = () =>
    writeWorkspaceSkills(ws, global, noEntrySkills, null).map((p) => path.relative(ws, p));
  assert.ok(!project().some((p) => p.includes("w9r-smart-standard")));
  fs.symlinkSync(repo, path.join(ws, "fhir"));
  assert.ok(project().includes(path.join(".claude", "skills", "w9r-smart-standard", "SKILL.md")));
});
