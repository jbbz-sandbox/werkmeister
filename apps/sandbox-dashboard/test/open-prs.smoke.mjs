// Smoke test for the Open PRs pure logic: failing-checks classifier, 30-day
// cutoff, prFromView mapping (outOfDate/changesRequested/approval-label/issueId/
// repo+number-from-url/unavailable stub), section split with self-exclusion, and
// the markdown-it config invariant (html:false). Synthetic JSON — no network.
//   npm run build && node lib/open-prs.smoke.mjs
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cfgFile = path.join(mkdtempSync(path.join(tmpdir(), "open-prs-")), "config.yaml");
writeFileSync(cfgFile, "jira:\n  base_url: https://example.atlassian.net/\n");
process.env.SANDBOX_CONFIG_FILE = cfgFile;

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  countFailingChecks,
  isWithin30Days,
  prFromView,
  assembleOpenPrs,
  APPROVAL_LABEL,
  isValidPrUrl,
  buildReconcileContext,
} = await import("werkmeister-core");
const { renderMarkdown } = await import(path.join(pkgRoot, "dist/lib/markdown.js"));

// 1. Failing-checks classifier: bad conclusions count; good/in-progress don't.
assert.equal(countFailingChecks([{ conclusion: "FAILURE" }]), 1, "FAILURE counts");
assert.equal(
  countFailingChecks([
    { conclusion: "SUCCESS" },
    { conclusion: "NEUTRAL" },
    { conclusion: "SKIPPED" },
  ]),
  0,
  "SUCCESS/NEUTRAL/SKIPPED do not count",
);
assert.equal(countFailingChecks([{ status: "IN_PROGRESS" }]), 0, "in-progress does not count");
assert.equal(
  countFailingChecks([
    { conclusion: "FAILURE" },
    { conclusion: "ACTION_REQUIRED" },
    { conclusion: "SUCCESS" },
  ]),
  2,
  "counts only the bad ones in a mix",
);
assert.equal(countFailingChecks([{ state: "FAILURE" }]), 1, "StatusContext state=FAILURE counts");
assert.equal(countFailingChecks(null), 0, "non-array rollup → 0");
console.log("✓ countFailingChecks");

// 2. 30-day cutoff.
const now = Date.parse("2026-07-11T00:00:00Z");
assert.equal(isWithin30Days("2026-07-01T00:00:00Z", now), true, "10 days ago is within");
assert.equal(isWithin30Days("2026-05-01T00:00:00Z", now), false, "71 days ago is outside");
assert.equal(isWithin30Days(undefined, now), true, "missing updatedAt → kept");
console.log("✓ isWithin30Days");

// 3. prFromView mapping.
const view = {
  url: "https://github.com/sandbox/sandbox/pull/1234",
  number: 1234,
  title: "PROJ-999 fix the thing",
  body: "body text",
  headRefName: "jaysonboyer/proj-999",
  updatedAt: "2026-07-10T00:00:00Z",
  author: { login: "someoneelse" },
  labels: [{ name: "ready-for-human-approval" }, { name: "bug" }],
  reviewDecision: "CHANGES_REQUESTED",
  mergeStateStatus: "BEHIND",
  statusCheckRollup: [{ conclusion: "FAILURE" }],
};
const pr = prFromView(view, "jaysonboyer");
assert.equal(pr.repo, "sandbox", "repo parsed from url");
assert.equal(pr.number, 1234, "number");
assert.equal(pr.reviewStatus, "CHANGES_REQUESTED", "reviewDecision CHANGES_REQUESTED");
assert.equal(pr.outOfDate, true, "mergeStateStatus BEHIND");
assert.equal(pr.failingChecks, 1, "one failing check");
assert.equal(pr.hasApprovalLabel, true, "approval label present");
// The default tracker (no overrides.issue_tracker) is jira; its URLs need jira.base_url.
assert.equal(pr.issueId, "PROJ-999", "issue id parsed from title");
assert.equal(
  pr.issueUrl,
  "https://example.atlassian.net/browse/PROJ-999",
  "issue url from the tracker config",
);
writeFileSync(cfgFile, "paths: {}\n");
assert.equal(prFromView(view, "me").issueUrl, null, "no tracker url config → no link");
assert.deepEqual(pr.labels, ["ready-for-human-approval", "bug"], "label names");

const clean = prFromView(
  { ...view, mergeStateStatus: "UNKNOWN", reviewDecision: "APPROVED" },
  "me",
);
assert.equal(clean.outOfDate, false, "UNKNOWN is not flagged out-of-date");
assert.equal(clean.reviewStatus, "APPROVED", "reviewDecision APPROVED");

// DISMISSED is the one status GitHub's reviewDecision cannot express — it has to
// be recovered from latestReviews, so it gets its own case.
const dismissed = prFromView(
  { ...view, reviewDecision: undefined, latestReviews: [{ state: "DISMISSED" }] },
  "me",
);
assert.equal(dismissed.reviewStatus, "DISMISSED", "DISMISSED recovered from latestReviews");

const stub = prFromView(
  { url: "https://github.com/sandbox/frontend/pull/77", unavailable: true },
  "me",
);
assert.equal(stub.repo, "frontend", "unavailable stub still knows repo from url");
assert.equal(stub.number, 77, "unavailable stub knows number from url");
assert.equal(stub.title, "(details unavailable)", "unavailable stub title");
console.log("✓ prFromView");

// 4. Section split: mine keeps my PRs; others excludes me + drops stale.
const mineView = {
  ...view,
  url: "https://github.com/sandbox/sandbox/pull/1",
  author: { login: "jaysonboyer" },
};
const otherFresh = {
  ...view,
  url: "https://github.com/sandbox/sandbox/pull/2",
  author: { login: "coworker" },
};
const otherIsMe = {
  ...view,
  url: "https://github.com/sandbox/sandbox/pull/3",
  author: { login: "jaysonboyer" },
};
const otherStale = {
  ...view,
  url: "https://github.com/sandbox/sandbox/pull/4",
  author: { login: "coworker" },
  updatedAt: "2026-01-01T00:00:00Z",
};
const res = assembleOpenPrs([mineView], [otherFresh, otherIsMe, otherStale], "jaysonboyer", now);
assert.equal(res.me, "jaysonboyer");
assert.deepEqual(
  res.mine.map((p) => p.number),
  [1],
  "mine section",
);
assert.deepEqual(
  res.others.map((p) => p.number),
  [2],
  "others: excludes me (3) and stale (4)",
);
assert.equal(APPROVAL_LABEL, "ready-for-human-approval", "label constant");
console.log("✓ assembleOpenPrs");

// 5. Markdown config invariant: raw HTML escaped, bare URL linkified.
const html = renderMarkdown("<script>alert(1)</script>\nsee https://example.com");
assert.ok(!html.includes("<script>"), "raw <script> must not pass through");
assert.ok(html.includes("&lt;script&gt;"), "raw HTML is escaped (html:false)");
assert.ok(html.includes('href="https://example.com"'), "bare URL linkified");
console.log("✓ renderMarkdown config");

// 6. launchPrReconcile URL guard: only canonical GitHub PR URLs pass (injection guard).
assert.equal(
  isValidPrUrl("https://github.com/sandbox/sandbox/pull/1234"),
  true,
  "canonical PR url ok",
);
assert.equal(
  isValidPrUrl('https://github.com/sandbox/sandbox/pull/1234" ; rm -rf ~'),
  false,
  "shell-metachar url rejected",
);
assert.equal(isValidPrUrl("https://evil.com/a/b/pull/1"), false, "non-github host rejected");
assert.equal(
  isValidPrUrl("https://github.com/sandbox/sandbox/pull/abc"),
  false,
  "non-numeric PR rejected",
);
console.log("✓ isValidPrUrl injection guard");

// 7. buildReconcileContext: embeds issue + PR + diff; truncates a huge diff.
const ctx = buildReconcileContext(
  { ref: "PROJ-1", title: "Do a thing", status: "In Review", description: "ticket body" },
  {
    url: "https://github.com/sandbox/sandbox/pull/9",
    title: "PR title",
    body: "pr body",
    author: { login: "me" },
    labels: [{ name: "ready-for-human-approval" }],
  },
  "diff --git a b",
);
assert.ok(ctx.includes("PROJ-1") && ctx.includes("ticket body"), "embeds the issue");
assert.ok(
  ctx.includes("PR title") && ctx.includes("pr body") && ctx.includes("@me"),
  "embeds PR details",
);
assert.ok(ctx.includes("diff --git a b"), "embeds diff");
const bigCtx = buildReconcileContext(
  { ref: "PROJ-2" },
  { url: "https://github.com/x/y/pull/1", unavailable: true },
  "x".repeat(200_000),
);
assert.ok(bigCtx.includes("diff truncated"), "huge diff is truncated");
assert.ok(bigCtx.includes("(PR details unavailable)"), "unavailable PR degrades in place");
console.log("✓ buildReconcileContext");

// 8. PR row: an unlinked issue key (no tracker URL) must not reuse the link's
// class, or it underlines on hover like a dead link (#116). No DOM here, so
// check prs-ui.ts source: the unlinked span's class is styled but has no :hover.
const prsUi = readFileSync(path.join(pkgRoot, "src/prs-ui.ts"), "utf8");
const unlinkedCls = /:\s*el\("span",\s*"([^"]+)",\s*pr\.issueId\)/.exec(prsUi)?.[1];
assert.ok(unlinkedCls, "unlinked issue key is rendered as a span");
assert.notEqual(unlinkedCls, "issue-link", "unlinked key does not reuse the link class");
assert.ok(new RegExp(`\\.prs \\.${unlinkedCls}\\b(?!:)`).test(prsUi), "unlinked key is styled");
assert.ok(!new RegExp(`\\.${unlinkedCls}:hover`).test(prsUi), "unlinked key has no hover style");
assert.ok(
  /\.prs \.issue-link:hover \{ text-decoration: underline; \}/.test(prsUi),
  "linked key still underlines",
);
console.log("✓ unlinked issue key is not styled as a link");

console.log("ALL PASS");
process.exit(0);
