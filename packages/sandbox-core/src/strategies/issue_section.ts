/** The issue section both strategies print: same words, same place in each file. */
import type { IssueRef } from "./types.js";

export function renderIssueRef(issue: IssueRef): string {
  const name = issue.url ? `[${issue.ref}](${issue.url})` : issue.ref;
  const title = issue.title ? `: ${issue.title}` : "";
  const copy = issue.fetchedAt
    ? `Copy taken ${issue.fetchedAt.slice(0, 10)}: \`.sandbox/issue.md\`.`
    : "No stored copy; run `sandbox init-workspace --refresh-issue`.";
  return [
    "## Issue",
    "",
    `${name}${title}. ${copy}`,
    "Before each stage, re-read the live issue for newer direction: `sandbox issue view`",
    "",
  ].join("\n");
}
