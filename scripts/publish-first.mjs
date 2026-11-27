#!/usr/bin/env node
/**
 * SW-1267, before `changesets/action` in ci.yml's release job. The action publishes only when no
 * changeset is pending, so a version already on main never shipped while one was (KNOWN-ISSUES
 * 27), and a changeset naming only ignored packages, which `changeset version` never consumes, kept
 * it versioning nothing for good (run 46043187201). This tells the job when to hide the pending
 * changesets so the action publishes. A lookup that fails counts as "don't know" and changes nothing.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {{ unpublished: string[], pending: number | null, versionable: number | null }} facts
 *   unpublished: public `name@version`s on main that npm doesn't have
 *   pending: changeset files on main; versionable: how many of them `changeset version` consumes
 * @returns {{ hide: boolean, restore: boolean, notices: string[] }} hide the pending changesets
 *   for a publish-mode run; restore them afterwards so the action still versions them
 */
export function publishPlan({ unpublished, pending, versionable }) {
  const notices = [];
  if (!(pending > 0) || versionable == null) return { hide: false, restore: false, notices };
  if (versionable === 0) {
    // Version mode would change nothing and fail to open an empty PR: let the action publish.
    notices.push(`${pending} pending changeset(s) name only ignored packages; publishing instead`);
    return { hide: true, restore: false, notices };
  }
  if (unpublished.length === 0) return { hide: false, restore: false, notices };
  notices.push(`Publishing ${unpublished.join(", ")} before versioning`);
  return { hide: true, restore: true, notices };
}

/**
 * @param {string[]} changesets the `.changeset/*.md` texts
 * @param {string[]} ignore `.changeset/config.json` `ignore`
 * @returns {number} the changesets `changeset version` consumes: empty ones (`changeset add
 *   --empty`) and any naming a package outside `ignore`. One naming only ignored packages stays.
 */
export function countVersionable(changesets, ignore) {
  return changesets.filter((text) => {
    const front = text.match(/^---\n([\s\S]*?)\n?---/)?.[1] ?? "";
    const names = [...front.matchAll(/^["']?([^"':\s]+)["']?\s*:/gm)].map((m) => m[1]);
    return names.length === 0 || names.some((n) => !ignore.includes(n));
  }).length;
}

/** Public `name@version`s that `npm view` doesn't find (any failure counts: publish skips what's there). */
function unpublishedOnNpm() {
  const ls = spawnSync("pnpm", ["-r", "ls", "--depth", "-1", "--json"], { encoding: "utf8" });
  if (ls.status !== 0) {
    console.log(`::warning::publish-first: pnpm ls failed: ${ls.error ?? ls.stderr.trim()}`);
    return [];
  }
  return JSON.parse(ls.stdout)
    .filter((p) => !p.private)
    .map((p) => `${p.name}@${p.version}`)
    .filter(
      (spec) => spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" }).status !== 0,
    );
}

/** Pending changeset files and how many `changeset version` consumes, or nulls when unreadable. */
function pendingChangesets() {
  try {
    const files = readdirSync(".changeset").filter((f) => f.endsWith(".md") && f !== "README.md");
    const { ignore = [] } = JSON.parse(readFileSync(".changeset/config.json", "utf8"));
    const texts = files.map((f) => readFileSync(`.changeset/${f}`, "utf8"));
    return { pending: files.length, versionable: countVersionable(texts, ignore) };
  } catch (e) {
    console.log(`::warning::publish-first: reading .changeset failed: ${e.message}`);
    return { pending: null, versionable: null };
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = publishPlan({ unpublished: unpublishedOnNpm(), ...pendingChangesets() });
  for (const n of plan.notices) console.log(`::notice::${n}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `hide=${plan.hide}\nrestore=${plan.restore}\n`);
}
