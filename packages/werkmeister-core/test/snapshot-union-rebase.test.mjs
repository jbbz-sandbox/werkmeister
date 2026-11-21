// SW-895: a grouped branch's per-ticket commits each change the one JSON line
// that embeds generated text, so an autosquash rebase conflicted on the
// snapshot at every step. With the repo's `merge=union` attribute the picks
// apply without a stop, and `--exec` regenerates the file at each step.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const SNAP = "packages/werkmeister-core/test/strategy-jit.snapshot.json";
// A calling git (`git rebase --exec`) exports these, and each beats `cwd` (SW-520).
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"].includes(k),
  ),
);
Object.assign(env, {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_EDITOR: "true",
});
// The snapshot's shape: one key per line, and one key holds every ticket's source text on one line.
const GEN =
  'const fs = require("node:fs"); const src = fs.readFileSync("src.txt", "utf8").trim().split("\\n").filter((l) => l !== "-");' +
  `fs.writeFileSync(${JSON.stringify(SNAP)}, JSON.stringify({ "pr-rules.md": src.join(" | "), "other.md": "x" }, null, 2) + "\\n");`;

test("the repo's .gitattributes lets an autosquash over per-ticket snapshot changes run without a stop", async () => {
  const attrs = fs.readFileSync(path.join(REPO, ".gitattributes"), "utf8");
  assert.match(attrs, new RegExp(`^${SNAP.replaceAll(".", "\\.")} merge=union$`, "m"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "union-rebase-"));
  const git = (...args) => run("git", args, { cwd: dir, env });
  const commit = async (msg, line, text) => {
    const src = fs.readFileSync(path.join(dir, "src.txt"), "utf8").split("\n");
    src[line] = text;
    fs.writeFileSync(path.join(dir, "src.txt"), src.join("\n"));
    await run("node", ["gen.cjs"], { cwd: dir, env });
    await git("commit", "-qam", msg);
  };
  try {
    await git("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(dir, ".gitattributes"), attrs);
    fs.writeFileSync(path.join(dir, "gen.cjs"), GEN);
    // Spacer lines: git counts edits to adjacent lines as one conflict.
    fs.writeFileSync(path.join(dir, "src.txt"), "a0\n-\n-\n-\nb0\n");
    fs.mkdirSync(path.join(dir, path.dirname(SNAP)), { recursive: true });
    await run("node", ["gen.cjs"], { cwd: dir, env });
    await git("add", "-A");
    await git("commit", "-qm", "base");
    const base = (await git("rev-parse", "HEAD")).stdout.trim();
    await commit("A ticket a", 0, "a1");
    await commit("B ticket b", 4, "b1");
    await commit("fixup! A ticket a", 0, "a2");

    await git(
      "rebase",
      "-i",
      "--autosquash",
      base,
      "--exec",
      "node gen.cjs && git commit -q --amend --no-edit -a",
    );

    const log = (await git("log", "--format=%s", `${base}..HEAD`)).stdout.trim().split("\n");
    assert.deepEqual(log, ["B ticket b", "A ticket a"]);
    const snap = fs.readFileSync(path.join(dir, SNAP), "utf8");
    assert.deepEqual(JSON.parse(snap), { "pr-rules.md": "a2 | b1", "other.md": "x" });
    // Each step regenerated the file, so no union-doubled line survives in either commit.
    const atA = (await git("show", `HEAD~1:${SNAP}`)).stdout;
    assert.deepEqual(JSON.parse(atA), { "pr-rules.md": "a2 | b0", "other.md": "x" });
    assert.equal(atA, JSON.stringify(JSON.parse(atA), null, 2) + "\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pr-rules rule 5 names the union attribute and a regenerating autosquash", async () => {
  const { buildPrRulesMd } = await import("../dist/pr_rules.js");
  assert.match(
    buildPrRulesMd("."),
    /never hand-merge it\. A rebase over your own per-ticket commits that each change a generated file: give the file `merge=union` in `\.gitattributes` \(when it holds one entry per line\) and run it as `git rebase --autosquash <base> --exec '<build> && <regenerate> && git commit --amend --no-edit -a'`, so each step regenerates the file\./,
  );
});
