// test-changed.mjs picks the core tests a change reaches, and falls back to the full suite when it can't tell.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { changedFiles, command, selectTests } from "./test-changed.mjs";

const PKG = "pkg";
const FILES = {
  "pkg/src/a.ts": "export const a = 1;\n",
  "pkg/src/b.ts": 'import { a } from "./a.js";\nexport const b = a;\n',
  "pkg/src/c.ts": "export const c = 1;\n",
  "pkg/src/lone.ts": "export const lone = 1;\n",
  "pkg/fixtures.mjs": 'export { b } from "./dist/b.js";\n',
  "pkg/a.test.mjs": 'import { a } from "./dist/a.js";\n',
  "pkg/h.test.mjs": 'import { b } from "./fixtures.mjs";\n',
  "pkg/c.test.mjs": 'const c = await import("./dist/c.js");\n',
  "pkg/text.test.mjs": 'fs.readFileSync(new URL("../tools/x.yaml", import.meta.url));\n',
  "pkg/s.smoke.mjs": "console.log('smoke');\n",
  "pkg/run-tests.sh": "#!/bin/sh\n",
  "pkg/package.json": "{}\n",
  "pkg/tsconfig.json": "{}\n",
  "pkg/x.snapshot.json": "{}\n",
  "tools/x.yaml": "a: 1\n",
  "README.md": "# repo\n",
  "pnpm-lock.yaml": "lockfileVersion: 9\n",
};

const git = (cwd, ...args) => {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k];
  return execFileSync("git", args, { cwd, env, encoding: "utf8" });
};

/** A temp repo whose `origin/main` holds FILES; `fn` gets its root and edits it. */
function withRepo(fn, { origin = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "test-changed-")));
  try {
    for (const [f, body] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), body);
    }
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-qm", "base");
    if (origin) git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const edit = (root, f) => fs.appendFileSync(path.join(root, f), "// changed\n");
const pick = (root, base) =>
  selectTests({
    changed: changedFiles({ repoRoot: root, base }).files,
    pkg: PKG,
    pkgDir: path.join(root, PKG),
  });

test("a src change picks the tests that reach it, through helpers and src imports", () =>
  withRepo((root) => {
    edit(root, "pkg/src/a.ts");
    git(root, "commit", "-qam", "branch change");
    const sel = pick(root);
    assert.deepEqual(sel.files, ["a.test.mjs", "h.test.mjs"]);
    assert.equal(sel.why["h.test.mjs"], "pkg/src/a.ts");
    assert.deepEqual(command(sel), ["sh", "run-tests.sh", "a.test.mjs", "h.test.mjs"]);
  }));

test("a committed and an uncommitted change both count", () =>
  withRepo((root) => {
    edit(root, "pkg/src/a.ts");
    git(root, "commit", "-qam", "branch change");
    edit(root, "pkg/c.test.mjs");
    assert.deepEqual(pick(root).files, ["a.test.mjs", "c.test.mjs", "h.test.mjs"]);
  }));

test("a changed test or smoke picks itself", () =>
  withRepo((root) => {
    edit(root, "pkg/c.test.mjs");
    assert.deepEqual(pick(root).files, ["c.test.mjs"]);
    fs.writeFileSync(path.join(root, "pkg/new.smoke.mjs"), "\n");
    assert.deepEqual(command(pick(root)), ["sh", "run-tests.sh", "c.test.mjs", "new.smoke.mjs"]);
  }));

test("a file outside the package picks the tests that name its path", () =>
  withRepo((root) => {
    edit(root, "tools/x.yaml");
    assert.deepEqual(pick(root).files, ["text.test.mjs"]);
  }));

for (const [f, reason] of [
  ["pkg/run-tests.sh", "run-tests.sh is not mapped to tests"],
  ["pkg/package.json", "package.json is not mapped to tests"],
  ["pkg/tsconfig.json", "tsconfig.json is not mapped to tests"],
  ["pkg/x.snapshot.json", "x.snapshot.json is not mapped to tests"],
  ["pnpm-lock.yaml", "pnpm-lock.yaml changed"],
  ["pkg/src/lone.ts", "src/lone.ts reached no test"],
]) {
  test(`full run when ${f} changes`, () =>
    withRepo((root) => {
      edit(root, f);
      const sel = pick(root);
      assert.deepEqual(sel, { mode: "full", reason });
      assert.deepEqual(command(sel), ["sh", "run-tests.sh"]);
    }));
}

test("a git error throws, so main falls back to the full run", () =>
  withRepo((root) => {
    assert.throws(() => changedFiles({ repoRoot: root, base: "nope" }));
  }));

test("no origin/main throws too", () =>
  withRepo(
    (root) => {
      assert.throws(() => changedFiles({ repoRoot: root }));
    },
    { origin: false },
  ));

test("no core change runs nothing", () =>
  withRepo((root) => {
    edit(root, "README.md");
    const sel = pick(root);
    assert.equal(sel.mode, "none");
    assert.equal(command(sel), null);
  }));

test("run-tests.sh given .mjs files runs only those", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-tests-"));
  // A nested node --test sees NODE_TEST_CONTEXT and skips running its files.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  try {
    fs.copyFileSync(path.join(import.meta.dirname, "run-tests.sh"), path.join(dir, "run-tests.sh"));
    fs.writeFileSync(path.join(dir, "no-gh.sh"), "#!/bin/sh\n");
    for (const n of ["one", "two"]) {
      fs.writeFileSync(
        path.join(dir, `${n}.test.mjs`),
        `import { test } from "node:test";\ntest("${n}", () => console.log("ran ${n}"));\n`,
      );
      fs.writeFileSync(path.join(dir, `${n}.smoke.mjs`), `console.log("smoke ${n}");\n`);
    }
    const out = execFileSync("sh", ["run-tests.sh", "one.test.mjs", "two.smoke.mjs"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.match(out, /ran one/);
    assert.match(out, /smoke two/);
    assert.doesNotMatch(out, /ran two|smoke one/);
    const smokeOnly = execFileSync("sh", ["run-tests.sh", "one.smoke.mjs"], {
      cwd: dir,
      env,
      encoding: "utf8",
    });
    assert.equal(smokeOnly.trim(), "smoke one");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
