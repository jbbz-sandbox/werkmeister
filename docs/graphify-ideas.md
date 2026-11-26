# Graphify: more ways to use it

Today Graphify is used in triage only (`plugins/werkmeister/skills/triage/SKILL.md`): `graphify_find`, `graphify_impact` and `graphify_tests_for` build the code map and the `Touches:` comment. These are ideas for other places, ordered by payoff.

1. **`/next-wave` collision check.** Before starting autonomous workspaces in parallel, intersect each ticket's `graphify_impact` file set. Tickets that overlap get grouped (the `group` field) or run one after another. Reuses the data triage already gathers.
2. **Test selection in a workspace** (`fast-tests`). `graphify_tests_for` on the changed symbols gives a fast first run; the full suite stays the gate. Empty answer → fall back to `git grep`.
3. **PR reviewer context** (`workspace-pr` / `ask-pr-review`). Add a section from `graphify_impact include_risk=true` listing connected code with no test links, so reviewers look at the risky parts.
4. **Research stage seeding.** Besides the `Touches` comment, pull `graphify_file_neighbors` and `graphify_trace` for the main symbol so the agent starts with a map.
5. **Shared memory across workspaces** (`remember` / `recall`). `/postmortem` saves each agreed lesson with `remember`; the research stage `recall`s notes on the same files, so parallel workspaces learn from each other.
6. **Dead-code audit** (`ponytail-audit`). Exported symbols with zero callers are candidates, each confirmed with grep before calling it dead.
7. **Triage hotspots.** `graphify_rank_files` plus tickets per file shows modules that keep producing tickets: refactor candidates or a priority signal.
8. **Docs drift** (`visual-explainer:fact-check`, docs reviews). Resolve every symbol a doc names with `graphify_find`; one that no longer resolves marks a stale doc.

Start with 1 (data already exists) and 5 (nothing else provides it).

**Caveat for all of them:** the graph misses imports across packages (`seedDashboardHome` showed 0 callers but has callers in `apps/cli`), so any "zero callers" or "no tests" answer needs the grep fallback.
