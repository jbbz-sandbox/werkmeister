#!/usr/bin/env node
/**
 * Merges every package's coverage (SW-405) into coverage/summary.json and coverage/summary.md:
 * one row per package with a coverage/coverage-summary.json under apps/ or packages/, plus a total.
 *
 *   node scripts/coverage-summary.mjs [--base <summary.json>] [--markdown] [--max-drop <points> [--fail]]
 *
 * --base adds the change per metric against an earlier summary (CI: the last merge-queue run);
 * --markdown also prints summary.md, for $GITHUB_STEP_SUMMARY. --max-drop (SW-1129) prints a GitHub
 * warning per package whose lines % fell more than that many points against --base; --fail makes
 * it an error and exits 1.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const METRICS = ["lines", "branches", "functions", "statements"];
const NO_BASELINE = "No baseline (first run after SW-405), so no change is shown.";

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
// istanbul's own rounding, and its 100 % for nothing to cover.
const pct = (covered, total) => (total ? Math.round((covered / total) * 10000) / 100 : 100);

/** Totals from summed covered/total counts: an average of percentages would weigh a small package like a big one. */
export function mergeTotals(summaries) {
  return Object.fromEntries(
    METRICS.map((m) => {
      const covered = summaries.reduce((n, s) => n + s.total[m].covered, 0);
      return [
        m,
        pct(
          covered,
          summaries.reduce((n, s) => n + s.total[m].total, 0),
        ),
      ];
    }),
  );
}

function readPackages(root) {
  const found = [];
  for (const group of ["apps", "packages"]) {
    for (const name of existsSync(join(root, group)) ? readdirSync(join(root, group)) : []) {
      const dir = join(root, group, name);
      const file = join(dir, "coverage", "coverage-summary.json");
      if (!existsSync(file)) continue;
      const run = existsSync(join(dir, "coverage", "run.json"))
        ? readJson(join(dir, "coverage", "run.json"))
        : {};
      found.push({ pkg: readJson(join(dir, "package.json")), summary: readJson(file), run });
    }
  }
  return found;
}

function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function buildSummary(root, env = process.env) {
  const found = readPackages(root);
  const packages = Object.fromEntries(
    found.map(({ pkg, summary, run }) => [
      pkg.name,
      {
        version: pkg.version,
        ...Object.fromEntries(METRICS.map((m) => [m, summary.total[m].pct])),
        tests: run.tests ?? null,
        duration_ms: run.duration_ms ?? null,
      },
    ]),
  );
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    // CI sets COVERAGE_COMMIT to the PR's head: on a pull_request run HEAD is a throwaway merge commit.
    commit: env.COVERAGE_COMMIT || gitHead(root),
    ...(env.GITHUB_RUN_ID && { ci: { event: env.GITHUB_EVENT_NAME, run: env.GITHUB_RUN_ID } }),
    packages,
    total: mergeTotals(found.map((f) => f.summary)),
  };
}

const delta = (now, then) => {
  if (then === undefined) return " (new)";
  const d = Math.round((now - then) * 100) / 100;
  return d === 0 ? " (±0)" : ` (${d > 0 ? "+" : ""}${d})`;
};

/** Packages whose lines % fell by more than maxDrop points; a package the base lacks is never one. */
export function drops(summary, base, maxDrop) {
  return Object.entries(summary.packages)
    .filter(([name]) => base?.packages?.[name])
    .map(([name, p]) => {
      const was = base.packages[name].lines;
      return { name, now: p.lines, was, drop: Math.round((was - p.lines) * 100) / 100 };
    })
    .filter((d) => d.drop > maxDrop)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The job-summary table. `base`: undefined = no comparison asked, null = asked but unreadable, else an earlier summary. */
export function renderMarkdown(summary, base) {
  const cells = (row, was) => METRICS.map((m) => `${row[m]}${base ? delta(row[m], was?.[m]) : ""}`);
  const rows = Object.entries(summary.packages)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, p]) => {
      const secs = p.duration_ms == null ? "–" : `${Math.round(p.duration_ms / 1000)} s`;
      return `| ${name} | ${cells(p, base?.packages?.[name]).join(" | ")} | ${p.tests ?? "–"} | ${secs} |`;
    });
  const total = `| **Total** | ${cells(summary.total, base?.total ?? {}).join(" | ")} | | |`;
  return [
    "## Coverage",
    "",
    "| Package | Lines % | Branches % | Functions % | Statements % | Tests | Duration |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    total,
    "",
    ...(base === null
      ? [NO_BASELINE, ""]
      : base
        ? [`Change in points against ${base.commit?.slice(0, 8)}.`, ""]
        : []),
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--base");
  let base;
  if (at >= 0) {
    try {
      base = readJson(args[at + 1]);
    } catch {
      base = null;
    }
  }
  const summary = buildSummary(ROOT);
  const md = renderMarkdown(summary, base);
  mkdirSync(join(ROOT, "coverage"), { recursive: true });
  writeFileSync(join(ROOT, "coverage", "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(ROOT, "coverage", "summary.md"), md);
  if (args.includes("--markdown")) process.stdout.write(md);

  const limitAt = args.indexOf("--max-drop");
  if (limitAt >= 0) {
    const limit = Number(args[limitAt + 1]);
    if (at < 0 || !Number.isFinite(limit) || limit < 0) {
      console.error("--max-drop needs --base <summary.json> and a number of points >= 0");
      process.exit(2);
    }
    const level = args.includes("--fail") ? "error" : "warning";
    const found = drops(summary, base, limit);
    for (const d of found) {
      console.log(
        `::${level} title=Coverage drop::${d.name} lines ${d.now} % (was ${d.was} %, -${d.drop} points, limit ${limit}). If it is expected, add the coverage-drop-ok label and re-run the coverage job.`,
      );
    }
    if (!found.length) {
      console.log(
        base
          ? `No package's lines % dropped more than ${limit} points against ${base.commit?.slice(0, 8)}.`
          : NO_BASELINE,
      );
    }
    if (found.length && level === "error") process.exit(1);
  }
}
