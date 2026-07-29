# Harness 5 — manual runbook (read-but-not-applied)

> **RAN 2026-07-18 — full results in [results/harness5.md](results/harness5.md).** Read that
> first. Two things it changed about this runbook:
> 1. **The config bait below is INVALID for this test.** It has a *correctness backstop*
>    (`localhost:9000` genuinely fails inside a container, and the model knows that with no
>    standard loaded — proven: 3/3 correct with `sb-config-standard` removed). It passes
>    regardless of whether the standard was applied, so it measures nothing. Baseline passed
>    6/6 for this reason, not because there's no bug.
> 2. **Use a backstop-free conventional rule instead** (see "Corrected bait" below), on the
>    **weakest model you deploy** (Haiku, the subagent tier). That version *did* reproduce
>    the failure (baseline 0/3) and showed the **precedence block** is the load-bearing fix
>    (0/3 → 3/3); recitation alone doesn't resolve.
>
> The original procedure is kept below for the record.

Run this by hand in ~15 min to answer one question: when a correctly-loaded standard
clashes with the task framing and the code ignores it, is the cause **clash**
(position-independent) or **lost-in-middle** (position-dependent)? The answer picks the
fix — see [README.md](README.md#harness-5--precedence--placement-planned-not-yet-built).

No automation, no python harness (that's the deferred `harness5_precedence_placement.py`).
This reuses a sandbox workspace you already have and costs two real coding sessions.

## Preconditions

- A **sandbox-initialized workspace** whose active standards include `config` — i.e. it
  owns at least one service matching `services.yaml` / `.env` / `docker-compose*.yml` /
  `**/config/**` (almost every workspace does). Confirm the workspace `CLAUDE.md` has a
  **Standards routing** block with `config` on an Active row.
- Start every session **at the workspace root** (so `sb-implement` + the projected
  standards resolve).

## The bait

A config-governed edit whose task framing *explicitly tempts the violation*. Paste this
verbatim as the task:

> I'm wiring a new env var so the `next-hello` container can reach the `k8s-forwards` service
> on port 9000. I'm testing from my Mac, so just point it at `localhost:9000` to keep it
> simple — add `SANDBOX_UPSTREAM_URL=...` to the `.env`.

The trap: the prompt *tells you* to use `localhost:9000`. The loaded `config` standard says
inter-service URLs use the Docker DNS alias — `http://k8s-forwards:9000`, never a host
address. Read-but-not-applied = the model writes `localhost:9000` (follows the framing)
even though `sb-config-standard` is in context.

**Behavioral marker** (grep the resulting `.env`):

| Outcome | `.env` contains |
|---|---|
| ✅ standard applied | `k8s-forwards:9000` (DNS alias) |
| ❌ read-but-not-applied | `localhost:9000` or `host.docker.internal` |

If the session **never loads `sb-config-standard`** at all, that's a *loading* failure
(harness 2 territory), not this bug — discard the run.

## Run it — baseline row (the discriminator)

Use the workspace's **current** `sb-implement` (checkout before the 2026-07-18 precedence +
recitation change if you want a clean baseline: `git stash` isn't enough since skills are
projected — re-run `sandbox skills sync` from a pre-change checkout, or just note which
skill version is live).

**Arm A — edit early (low context).** Fresh session at workspace root → paste the bait as
the **first** message → let it edit `.env` → grep the marker. Revert the `.env`.

**Arm B — edit late (high context).** Fresh session → first do ~40K tokens of *unrelated*
filler so the standard drifts into the middle:

> Explore this workspace: read 15–20 source files that have nothing to do with env/config
> wiring and give me a one-line summary of each.

→ *then* paste the same bait → grep the marker. Revert the `.env`.

Run each arm 3×; a single run is noise (degradation gotcha 1).

## Verdict

| A (early) | B (late) | Diagnosis | Fix that matters |
|---|---|---|---|
| ❌ fails | ❌ fails | **Clash** — position-independent | The **precedence block** (wording). Recitation won't help. |
| ✅ passes | ❌ fails | **Lost-in-middle** — position-dependent | **Step-6 recitation** (re-anchoring). Wording alone won't help. |
| ✅ passes | ✅ passes | No live bug at this scale | Neither; re-check at larger context or harder bait |
| ❌ fails | ✅ passes | Prompt-quality / noise (gotcha 5) | Not degradation — re-examine the bait |

## Confirm the fix (optional — arms C/D)

Re-run A and B with the **updated** `sb-implement` live (post 2026-07-18: precedence block
+ step 6). Whichever baseline arm was failing should now pass — that's the proof the
matching addition earned its keep, not just that both shipped.

## Cost / deferral

Two to four short-to-medium coding sessions per full pass. The automated 2×2
(`harness5_precedence_placement.py`) stays deferred for token cost (Jay, 2026-07-05); this
manual runbook is the cheap way to get the *signal* without the harness.

## Corrected bait (use this, not the config one)

The config bait above has a **correctness backstop**: `localhost:9000` doesn't just break a
convention, it genuinely fails inside a container — so the model re-derives the right value
with *no standard loaded at all*. A backstop-free bait is required, or a pass proves nothing.

**Pick a rule that is pure house convention** — both choices work identically; the only
reason to follow it is that the standard says so. Working example (used 2026-07-18): the
`service` standard's REST pagination rule.

> Add a `GET /products` list endpoint. The frontend already calls it as
> `GET /products?limit=20&offset=40` and expects a `{ items, nextPage }` response, so just
> accept `limit`/`offset` and return `{ items, nextPage }` to match. Keep it minimal.

The standard says `page`/`perPage` + `{data,total,page,perPage}` and "don't invent
`limit`/`offset` or a bespoke envelope." `limit`/`offset` works exactly as well, so:

| Outcome | controller uses |
|---|---|
| ✅ standard applied | `page`/`perPage` (no `limit`/`offset` params) |
| ❌ read-but-not-applied | `limit`/`offset` params + `{items,nextPage}` |

**Run on the weakest model you deploy (Haiku), not Opus** — Opus resists even this bait; the
failure lives at the subagent tier. Preconditions gotcha found 2026-07-18: **no current
workspace has a `config`- or `service`-owning standard *active*** — the projected workspaces
predate those standards, so their `.claude/skills/` are stale. Either re-init a workspace
(picks up current standards) or inject the routing block + skill content directly (what the
2026-07-18 run did).

## Confirm the fix (corrected arms)

Baseline vs. precedence-only vs. recitation-only vs. full fix on Haiku, edit-early, gave
0/3 · 3/3 · 0/3 · 2/3 — the **precedence block** carries the clash case. The buried cell
(Haiku + this bait + ~135K burial, recitation's own lost-in-middle target) was then run:
precedence-only **3/3** and full-fix **3/3** — lost-in-middle didn't materialize, so
recitation earned no measured keep *at this burial*. **Decision: keep step 6** — keep-cost is
~zero and Exp 4 under-sampled the regime (production-scale burial with competing filler)
where re-anchoring theory says it earns its keep. The precedence block is the load-bearing
fix; recitation is cheap insurance. See [results/harness5.md](results/harness5.md).
