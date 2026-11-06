---
"werkmeister-core": patch
"werkmeister": patch
---

PR rules and gate fixes (SW-494 group):

- SW-494: a `pr watch` conflict wake tells the session to rebase onto `origin/<base>` (never merge it in), to take the base's copy of a conflicting generated file and regenerate it, and prints the person's `git -C <worktree> push --force-with-lease=<branch>:<old sha>` filled in; `pr-rules.md` rule 5 says the same.
- SW-493: a chat reply of "continue" counts as approval, beside "decided", "approved" and "proceed".
- SW-116: `pr-rules.md` says `pr open` runs the gate itself, so `pr gate` is only for checking without opening.
- SW-155: the PR file's acceptance table takes `MANUAL` for a criterion only the reviewer can check; the gate passes it and lists it.
- SW-119: a registry `test: none` (or `test: "none: <reason>"`) marks a service with no tests; the gate reports it skipped with the reason.
- SW-490: `pr gate` fails while a decided question in `decisions.md` promises a follow-up and names no issue key.
