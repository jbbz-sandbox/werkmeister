#!/usr/bin/env node
/**
 * Before `changesets/action` in ci.yml's release job: decides whether that step runs, and writes
 * the answer to $GITHUB_OUTPUT. A lookup that fails counts as "don't know" and changes nothing.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {{ queuedPr: number | null }} facts
 *   queuedPr: the open `changeset-release/main` PR that is in the merge queue, if any
 * @returns {{ runChangesets: boolean, notices: string[] }}
 */
export function releasePlan({ queuedPr }) {
  const notices = [];
  let runChangesets = true;

  // SW-1266: GitHub refuses any push to a queued PR's branch (GH006), and version mode force-pushes
  // it. The queued version commit still publishes when it lands; this push's changesets ride the next.
  if (queuedPr != null) {
    runChangesets = false;
    notices.push(`Version PR #${queuedPr} is in the merge queue; skipping the version step`);
  }

  return { runChangesets, notices };
}

/** The number of the open `changeset-release/main` PR in the merge queue, or null. */
function queuedVersionPr() {
  // The query queue-version-pr.yml runs. No author filter: GH006 refuses the push whoever opened it.
  const r = spawnSync(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `o=${process.env.OWNER}`,
      "-f",
      `r=${process.env.NAME}`,
      "-f",
      "b=changeset-release/main",
      "-f",
      "query=query($o:String!,$r:String!,$b:String!){repository(owner:$o,name:$r){pullRequests(headRefName:$b,states:OPEN,first:5){nodes{number isInMergeQueue}}}}",
      "--jq",
      ".data.repository.pullRequests.nodes[] | select(.isInMergeQueue) | .number",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.log(
      `::warning::release-plan: merge-queue lookup failed: ${r.error ?? r.stderr.trim()}`,
    );
    return null;
  }
  const n = Number.parseInt(r.stdout, 10);
  return Number.isNaN(n) ? null : n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const plan = releasePlan({ queuedPr: queuedVersionPr() });
  for (const n of plan.notices) console.log(`::notice::${n}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `run_changesets=${plan.runChangesets}\n`);
}
