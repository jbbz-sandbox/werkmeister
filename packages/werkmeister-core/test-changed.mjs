// `pnpm run test:changed`: run only the core tests a branch's changes can reach, through run-tests.sh,
// and fall back to the full suite whenever a change can't be mapped with confidence.
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** git with the caller's GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR dropped (SW-520, as in run-tests.sh). */
function git(repoRoot, args) {
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[k];
  return execFileSync("git", args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Repo-relative paths changed since `base` (committed on the branch) plus the working tree. Throws on a git error. */
export function changedFiles({ repoRoot, base }) {
  const ref = base || git(repoRoot, ["merge-base", "HEAD", "origin/main"]).trim();
  const files = new Set(git(repoRoot, ["diff", "--name-only", "--no-renames", ref]).split("\n"));
  for (const line of git(repoRoot, ["status", "--porcelain", "--untracked-files=all"]).split(
    "\n",
  )) {
    // "XY path" or "XY old -> new": both sides of a rename count.
    for (const p of line.slice(3).split(" -> ")) files.add(p);
  }
  files.delete("");
  return { base: ref, files: [...files].sort() };
}

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
const isTest = (f) => f.endsWith(".test.mjs") || f.endsWith(".smoke.mjs");

/** The package-root node an import specifier from `from` points at, or null for a package or node: import. */
function resolve(from, spec) {
  if (!spec.startsWith(".")) return null;
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  if (p.startsWith("dist/")) return `src/${p.slice(5).replace(/\.js$/, ".ts")}`;
  if (p.startsWith("src/")) return p.replace(/\.js$/, ".ts");
  return p;
}

/** What to run for `changed` (repo-relative paths); `pkg` is core's repo-relative dir, `pkgDir` its absolute path. */
export function selectTests({ changed, pkg, pkgDir, base = "the base" }) {
  if (changed.includes("pnpm-lock.yaml")) return { mode: "full", reason: "pnpm-lock.yaml changed" };
  const prefix = `${pkg}/`;
  const inPkg = changed.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  for (const f of inPkg) {
    if (f.startsWith("dist/") || f.startsWith("node_modules/")) continue;
    const mapped =
      (f.startsWith("src/") && f.endsWith(".ts")) || (!f.includes("/") && f.endsWith(".mjs"));
    if (!mapped) return { mode: "full", reason: `${f} is not mapped to tests` };
  }

  const roots = fs.readdirSync(pkgDir).filter((f) => f.endsWith(".mjs"));
  const srcFiles = fs
    .readdirSync(path.join(pkgDir, "src"), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/${f.split(path.sep).join("/")}`);
  const text = new Map(
    [...roots, ...srcFiles].map((f) => [f, fs.readFileSync(path.join(pkgDir, f), "utf8")]),
  );
  const outside = changed.filter((f) => !f.startsWith(prefix));

  // edges: node -> the files that depend on it (imports, or a root .mjs naming it in its text).
  const dependents = new Map();
  const edge = (to, from) => {
    if (!dependents.has(to)) dependents.set(to, new Set());
    dependents.get(to).add(from);
  };
  for (const [f, body] of text) {
    for (const [, spec] of body.matchAll(IMPORT)) {
      const to = resolve(f, spec);
      if (to && to !== f) edge(to, f);
    }
    if (!roots.includes(f)) continue;
    // Text edges: a test reading src/harness/<f> by name, or a repo file outside the package by path.
    for (const s of srcFiles) if (body.includes(path.posix.basename(s))) edge(s, f);
    for (const o of outside) if (body.includes(o)) edge(o, f);
  }

  const why = {};
  for (const start of [...inPkg, ...outside]) {
    const label = inPkg.includes(start) ? prefix + start : start;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const n = queue.shift();
      if (isTest(n) && !(n in why)) why[n] = label;
      for (const d of dependents.get(n) ?? []) {
        if (seen.has(d)) continue;
        seen.add(d);
        queue.push(d);
      }
    }
  }
  const files = Object.keys(why).sort();
  if (files.length) return { mode: "some", files, why };
  if (!inPkg.length) return { mode: "none", reason: `no werkmeister-core changes since ${base}` };
  return { mode: "full", reason: `${inPkg[0]} reached no test` };
}

/** The command to run for a selection, or null when there is nothing to run. */
export function command(selection) {
  if (selection.mode === "none") return null;
  return ["sh", "run-tests.sh", ...(selection.mode === "some" ? selection.files : [])];
}

function main() {
  const pkgDir = import.meta.dirname;
  let selection;
  try {
    const repoRoot = git(pkgDir, ["rev-parse", "--show-toplevel"]).trim();
    const { base, files } = changedFiles({ repoRoot, base: process.env.BASE });
    const pkg = path.relative(repoRoot, pkgDir).split(path.sep).join("/");
    selection = selectTests({ changed: files, pkg, pkgDir, base });
  } catch (e) {
    selection = {
      mode: "full",
      reason: `git failed: ${
        String(e.stderr || e.message)
          .trim()
          .split("\n")[0]
      }`,
    };
  }
  if (selection.mode === "some")
    for (const f of selection.files) console.log(`test-changed: ${f}  (via ${selection.why[f]})`);
  else
    console.log(
      `test-changed: ${selection.mode === "full" ? "full run, " : ""}${selection.reason}`,
    );
  const cmd = command(selection);
  if (!cmd) return 0;
  return spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", cwd: pkgDir }).status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  process.exitCode = main();
