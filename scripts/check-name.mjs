#!/usr/bin/env node
/**
 * Fail on the pre-Werkmeister name (SW-106): any tracked line that still says
 * "sandbox" once the names below are taken out. A line that must name the old
 * thing (a migration step, a pre-rename marker the code still recognises)
 * carries `name-check: ignore`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Records, research and tests: they name things as they were, or are internal (SW-106 decision 4). */
const SKIP = [
  /CHANGELOG\.md$/,
  /^\.changeset\//,
  /^pnpm-lock\.yaml$/,
  /^docs\/(naming|context-management)-research\.md$/,
  /^docs\/(research|superpowers)\//,
  /^docs\/scamper-/,
  /\.test\.[cm]?[jt]sx?$/,
  /\.smoke\.mjs$/,
  /(^|\/)(__tests__|test|bdd)\//,
  /\.snapshot\.json$/,
  // `werkmeister machine migrate` is the one reader of the pre-rename names.
  /^packages\/werkmeister-core\/src\/migrate\.ts$/,
  /^scripts\/check-name\.mjs$/,
];

/** Names that keep "sandbox" on purpose, each with the SW-106 decision that keeps it. */
export const KEEP = [
  /jbbz-sandbox/g, // the GitHub org
  /\bsandbox-workspace(?!s)\b/g, // the workspace record repo, local clone and GitHub repo
  /\bsandbox-tools\b/g, // the pre-rename plugin, named where it is retired and in its migration notes
  /X-Sandbox-Feature|x-sandbox-feature|SANDBOX_FEATURE/g, // decision 2: still sent and read in transition
  /\bsandbox\.(?:d\.)?(?:ts|js)\b|werkmeister-core\/(?:src\/)?sandbox\b/g, // decision 4: the module's file name
];

/** VS Code command, view and setting IDs (decision 3): users' keybindings and `when` clauses use them. */
const VSCODE_KEEP = [/\bsandbox\.[A-Za-z]\w*/g, /["']sandbox["']/g];

/**
 * Decision 4: identifiers stay. A word holding "sandbox" next to other word
 * characters is one (`SandboxError`, `sandboxRoot`, `with_sandbox_home`); a bare
 * word, an env name (`SANDBOX_X`) and the renamed config keys are not.
 */
function isIdentifier(word) {
  if (/^sandbox$/i.test(word) || /^SANDBOX_/.test(word)) return false;
  return !/^(?:sandbox_root|sandbox_issues_project)$/.test(word);
}

/** "file:line: text" for each line of *text* (at *rel*) that still says sandbox. */
export function checkName(rel, text) {
  const keep = rel.startsWith("packages/werkmeister-vscode/") ? [...KEEP, ...VSCODE_KEEP] : KEEP;
  const hits = [];
  text.split("\n").forEach((line, i) => {
    if (!/sandbox/i.test(line) || line.includes("name-check: ignore")) return;
    let rest = line;
    for (const re of keep) rest = rest.replace(re, "");
    rest = rest.replace(/[\w$]*sandbox[\w$]*/gi, (w) => (isIdentifier(w) ? "" : w));
    if (/sandbox/i.test(rest)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return hits;
}

/** Tracked and untracked-but-not-ignored files that mention the old name, so a new file is checked before its first commit (SW-200). */
export function oldNameFiles(root) {
  return execFileSync("git", ["grep", "--untracked", "-Iil", "sandbox"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((f) => f && !SKIP.some((re) => re.test(f)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = oldNameFiles(ROOT);
  const hits = files.flatMap((rel) => checkName(rel, readFileSync(join(ROOT, rel), "utf8")));
  for (const h of hits) console.error(h);
  console.log(
    `${files.length} files with the old name checked, ${hits.length} line(s) still say sandbox.`,
  );
  process.exit(hits.length ? 1 : 0);
}
