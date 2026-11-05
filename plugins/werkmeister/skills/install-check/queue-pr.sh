#!/bin/bash
# Merge a PR through the repo's merge queue: wait for its checks, enqueue it,
# wait for the merge. Auto-merge is off on the werkmeister repo, so
# `gh pr merge` (plain or --auto) fails there; the queue takes the GraphQL enqueue.
# Usage: queue-pr.sh <pr> [owner/repo]
# Exit 0 merged; 1 checks failed, the PR moved, it left the queue unmerged, or a wait timed out.
set -uo pipefail

PR="${1:?usage: queue-pr.sh <pr> [owner/repo]}"
R="${2:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
EVERY="${QUEUE_PR_INTERVAL:-30}"
TRIES="${QUEUE_PR_TRIES:-90}"

head_of() { gh pr view "$PR" -R "$R" --json headRefOid -q .headRefOid; }
queue_state() {
  gh api graphql -F n="$PR" -f o="${R%/*}" -f r="${R#*/}" \
    -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state isInMergeQueue}}}' \
    -q '.data.repository.pullRequest | "\(.state) \(.isInMergeQueue)"'
}

# A branch just pushed by a bot (the Changesets version PR) lists no checks for a while: not a failure.
for _ in $(seq 1 "$TRIES"); do
  gh pr checks "$PR" -R "$R" 2>&1 | grep -q "no checks reported" || break
  sleep "$EVERY"
done
head="$(head_of)"
if ! gh pr checks "$PR" -R "$R" --watch --interval "$EVERY" >/dev/null 2>&1; then
  echo "ERROR #$PR checks failed:"
  gh pr checks "$PR" -R "$R" 2>&1 | grep -v pass
  exit 1
fi
# A push during the wait (a version PR re-versioned by a merge to main) means the checks were another commit's.
[ "$(head_of)" = "$head" ] || { echo "ERROR #$PR moved during its checks; run again"; exit 1; }

id="$(gh pr view "$PR" -R "$R" --json id -q .id)"
gh api graphql -f id="$id" \
  -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){mergeQueueEntry{position}}}' \
  >/dev/null || { echo "ERROR #$PR could not be queued"; exit 1; }
echo "QUEUED #$PR"

for _ in $(seq 1 "$TRIES"); do
  sleep "$EVERY"
  case "$(queue_state)" in
    MERGED*) echo "MERGED #$PR"; exit 0 ;;
    # Out of the queue and still open: its merge_group run failed, or a push (force-push included) removed it.
    "OPEN false") echo "ERROR #$PR left the queue unmerged; see: gh run list -R $R -e merge_group -L 1"; exit 1 ;;
  esac
done
echo "ERROR #$PR still not merged after $((TRIES * EVERY))s"
exit 1
