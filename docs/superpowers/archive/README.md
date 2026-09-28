# Archived plans and specs

Finished work. Everything here shipped; nothing in this directory is a live
to-do list.

**Read the checkboxes with suspicion.** These plans were written with `- [ ]`
boxes as *specification* and, with one exception, were never ticked during
execution — `2026-09-25-claudeck-hardening.md` still shows 55 unchecked boxes
for work that is fully merged. Unchecked boxes here mean nothing. Where a plan
records what actually happened it does so in prose: a `**DONE**` banner at the
top, a `**Status: done**` line per phase, or an `## Execution record` section.

Archived 2026-09-25. Completion was confirmed per document rather than assumed:

| Document | Evidence it is done |
| --- | --- |
| `plans/2026-09-03-self-host-services.md` | The recipe is documented as a working feature in `docs/users-guide.md` ("Self-hosting the sandbox repo"), and the plan's single code fix landed — the configurable bind host at `apps/sandbox-dashboard/main.ts:30`. |
| `plans/2026-09-04-command-logic-to-core-1-foundations.md` | Carries `**Status: done**` on four phases, the last reading "All six clean; nothing carries over to plans 2 or 3". |
| `plans/2026-09-04-command-logic-to-core-2-tier-1.md` | All ten verbs' logic is in `packages/sandbox-core`: `config.ts`, `docker.ts`, `caddy.ts`, `detect.ts`, `standards.ts`, `workspace_skills.ts`, `stats.ts`. |
| `plans/2026-09-04-command-logic-to-core-3-tier-2.md` | The modules the seven tasks called for exist: `notes.ts`, `telepresence.ts`, `test_run.ts`. Task 3 unblocked claudeck's intercept read (`4835659`); Task 6's deliverable is `plans/2026-09-04-workspace-verbs-audit.md`. |
| `plans/2026-09-04-mcp-surface.md` | Has an `## Execution record`; the handoff below calls it the "Completed plan"; `apps/mcp` is merged, running, and its 12 tests are in the suite. |
| `plans/2026-09-04-mcp-surface-remaining.md` | Opens with `**DONE — 2026-09-04.**` — all three tasks executed, spec §10.4 passes. Note its own warning that Tasks 2 and 3 are wrong in four ways and the corrections live in the parent plan's execution record. |
| `plans/2026-09-04-tier-0-audit.md` | An audit report, not a build plan — it *is* the deliverable of plan 1's phase 5. |
| `plans/2026-09-04-workspace-verbs-audit.md` | Likewise: the deliverable of plan 3's Task 6. |
| `plans/2026-09-25-claudeck-hardening.md` | Merged at `61d4103` ("Merge branch 'fix/claudeck-hardening'") with the whole `fix(auth)`/`fix(exec)`/`fix(plugins)` series beneath it. Now also moot here: claudeck moved to its own repo the same day. |

The four specs under `specs/` are the designs behind those plans and were
archived with them.

## One caveat on the claudeck pair

`plans/2026-09-25-claudeck-hardening.md` and its design spec describe code that
no longer lives in this repo — claudeck was extracted to a sibling repo
(`../claudeck`) on 2026-09-25, so every `apps/claudeck/…` path in those two
documents now resolves there instead. They were kept here because they are the
record of work done while it was part of this monorepo.

## Archived 2026-09-28

| Document | Evidence it is done |
| --- | --- |
| `plans/2026-09-26-workspace-context-trim.md` | Carries `**Status: done**` at the top; merged at `df0f966` (PR #82). |
| `plans/2026-09-27-work-type-phases.md` | Merged in two PRs: the per-work-type phases at `5019abf` (#85) and the phase gate at `9973603` (#86). The gate is `phase_gate` in `packages/sandbox-core/gate.ts`. |

Their two specs still say `**Status:** proposed`; that line was never updated
after the design was built, so ignore it the same way you ignore the checkboxes.
