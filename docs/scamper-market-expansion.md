# SCAMPER — Alternative Uses for the sandbox Tool

> Ideation output, not a roadmap. Nothing here is committed to.
> Framework: SCAMPER (Bob Eberle, 1971), applied with weight on **P — Put to another use**.

---

## 1. What the tool actually is

Stated purpose: a multi-feature concurrent development orchestrator — up to 12 Claude
Code agents developing across ~15 services on one 32GB Mac, each running only the
services it changed.

That is the *application*. The reusable machinery underneath is broader, and the
alternative uses come from the machinery, not the application. Six primitives:

| # | Primitive | Where it lives |
|---|-----------|----------------|
| P1 | **Partial materialization** — infer the delta from git, run only that, borrow the rest from a live baseline | `sandbox detect`, `up`, `k8s-forwards` |
| P2 | **Per-request slice selection at the edge** — a cookie/header resolves each request to a candidate slice or the baseline | Caddy site blocks, `X-Feature`, selector UI |
| P3 | **Slot-based isolation + scheduling** — N concurrent tenants, each with its own network, port range, compose stack | `ports.yaml`, slot allocator, `up`/`down`/`clean` |
| P4 | **Multi-repo ephemeral provisioning** — worktrees across N repos on one branch, seeded, torn down | `sandbox workspace`, `init-workspace` |
| P5 | **Just-in-time context governance** — rules delivered by phase × domain × service presence, plus tool-allowlisted subagents and hook enforcement | JIT context system, generated `sb-*` skills |
| P6 | **Contracted durable state + explicit graduation** — notes survive subagent→agent, session→session, phase→phase; promotion out is deliberate | `.sandbox/notes/`, `sandbox notes graduate` |

Plus one asset that is not a primitive but is rare: **an empirical measurement rig**
(harnesses 1–9, kept outside this repo) that produced numbers on what
actually changes model behavior. Very few teams have run that experiment at all.

The one-line abstraction: **an ephemeral, per-actor, partially-materialized slice of a
distributed system, with governed context delivery and an edge that decides per request
which slice answers you.**

"Code agent sandbox manager" is one instantiation of that sentence. The rest of this
document is other instantiations.

---

## 2. S — Substitute

Swap one input; the machinery is unchanged.

| Swap | From → To | What it becomes |
|---|---|---|
| **The actor** | agent → prospect, student, candidate, incident responder, auditor | Demo envs, labs, interviews, post-mortems (see §5) |
| **The delta source** | git diff → feature-flag value, config change, schema migration, dependency bump, model version | Upgrade rehearsal; "run only the changed thing against a real baseline" generalizes far past code |
| **The baseline** | local k8s dev → staging, prod read-replica, recorded traffic replay | Shadow testing, incident reproduction |
| **The routing key** | `X-Feature` cookie → tenant ID, user cohort, region, model version | The Caddy layer becomes a canary / experimentation router |
| **The isolation boundary** | Docker + network → Firecracker / gVisor microVM | Turns a *convenience* boundary into a *security* boundary — the precondition for any untrusted-code use |
| **The standards source** | org standards tree → regulatory controls, accessibility rules, framework conventions | The JIT loader is content-agnostic; the content is the product surface |
| **The harness** | Claude Code skills → Cursor rules, Copilot instructions, Windsurf, plain MCP | Addressable market goes from "Claude Code users" to "teams using any coding agent" |

The substitution that matters most: **isolation boundary**. Today's claim of "sandbox"
is a Docker network, which is a blast-radius reducer, not a containment boundary. Several
uses below are gated on fixing that, and it should not be oversold until it is.

## 3. C — Combine

- **Lifecycle + notes + tool-allowlists → a provenance record.** Every ephemeral
  workspace already knows which standards were loaded, which subagents ran under which
  tool gates, what notes survived, and what graduated. Emitting that as a signed artifact
  turns byproduct into evidence (§5.3).
- **`sandbox stats` + token accounting → cost per feature per agent.** Container cost and
  model cost are the same question for an agent fleet and nobody reports them together.
- **Slot allocator + CI → a preview-environment scheduler.** The 12-slot allocator is
  already a scheduler; CI is just another requester.
- **JIT context + the existing Jira integration → standards selected by ticket type.**
  A migration ticket and a UI ticket should not load the same rules.
- **Measurement rig + standards tree → a standards-effectiveness lab.** "Does this rule
  actually change model behavior, and by how much?" is answerable here and essentially
  nowhere else. This is the most defensible combination in the document.

## 4. A — Adapt

- **From Vercel/Netlify preview deploys:** same shape, but for stateful distributed
  backends rather than static frontends — the case the preview-deploy vendors handle worst.
- **From monorepo build caching (Turbo, Bazel):** they compute the delta and skip
  unchanged *builds*. P1 computes the delta and skips unchanged *runtime*. Positioning
  handle: "Turborepo, but for running."
- **From device farms:** N slots ↔ N concurrent agents is a device-farm scheduler with a
  different resource type. The queuing, fairness, and reclamation problems are solved ones.
- **From teaching labs:** pre-seeded environment + a task prompt + automatic teardown.
  `workspace.yml`'s `starting_prompt` and the notes layer are most of a lab runner already.

## 5. P — Put to another use

Ranked by *(existing machinery reused) × (buyer has budget) × (distance from incumbents)*.

### 5.1 Agent evaluation harness for realistic multi-service tasks — **strongest**

Public coding-agent benchmarks are single-repo, static, and non-running. SWE-bench hands a
model a patch-shaped problem in one repository. Nothing widely used evaluates an agent
against a **running, stateful, multi-service system** where the failure modes are service
boundaries, config drift, and cross-repo change.

This repo has every piece: identical isolated slices on demand (P3, P4), a real
distributed baseline (P1), per-run governance so runs are comparable (P5), durable
per-run records (P6), and a prior art rig that already ran nine such experiments.

Buyers: model labs, agent-tool vendors, and enterprise platform teams choosing between
coding agents — all of whom currently decide on vibes and a leaderboard that does not
resemble their codebase.

Reuse: very high. Distance from incumbents: very high. This is the idea nobody else on
the list can easily copy.

### 5.2 Ephemeral preview environments for distributed backends

`up` / `down` / `status` / cookie-routing *is* a preview-environment product. Point it at
a PR instead of a local worktree and the machinery is unchanged.

Buyer: platform engineering, with an existing and well-understood budget line. But the
category is contested — Signadot, Uffizzi, Okteto, Garden, Bunnyshell, Release. Signadot
in particular sells request-level isolation against a shared baseline, which is P2.

Differentiator, if pursued: laptop-first (the incumbents are cluster-first and cost per
environment), and agent-native (the incumbents provision for humans and CI, not for twelve
concurrent agents needing governed context). Enter on the second differentiator, not the first.

### 5.3 AI governance & compliance evidence

"Prove which rules were in the agent's context when it wrote this code, which tools it was
permitted to call, and who approved what graduated out of the workspace."

Under an internal AI policy, SOC2 evidence collection, or EU AI Act obligations, that
question is being asked and answered today with screenshots and assertions. The
combination in §3 produces it as a byproduct of work already being done.

The commercially interesting part is that this is a **compliance** budget, not a
developer-tools budget: larger, less price-sensitive, and bought by someone who is not
choosing between this and a free alternative.

Reuse: high — mostly emitting what already exists. Effort is in retention, signing, and
report shape, not in new machinery.

### 5.4 Sales-engineering / per-prospect demo environments

Every solutions engineer wants a pristine instance with prospect-shaped data, live in
seconds, gone afterward. Cookie-routed per-prospect slice, baseline for the boring 90%,
`down` when the call ends. Small market per customer, but very short path from what exists.

### 5.5 Training, onboarding, and certification labs

Bootcamps, internal onboarding, conference workshops, interview take-homes. Pre-seeded
worktrees, a starting prompt, standards as the curriculum's guardrails, teardown on exit.
The same runner covers all four audiences; only the content differs.

### 5.6 Migration rehearsal and dependency-upgrade dry runs

Renovate and Dependabot tell you a bump *exists*. Nothing tells you it *works in situ*.
Materialize one service on the new version, leave everything else at baseline, replay
traffic, diff the behavior. This is P1 with the delta source substituted (§2).

### 5.7 Incident reproduction as a first-class artifact

Spin a workspace pinned to the commit and config of a production incident, replay captured
traffic against it. The post-mortem stops being a document and becomes something you can run.

### 5.8 Chaos and resilience testing

Point one service at a fault-injecting proxy while everything else stays baseline. "Only
the thing under test is different" is precisely the chaos-experiment shape, and P2 already
implements it.

### 5.9 Standards distribution as its own product

`sandbox-standards` is already split into its own repo behind
`overrides.standards_dir` — the CLI is machinery, the tree is content. That separation is
the seam a product ships along: **ESLint for the things ESLint cannot check, delivered to
a model at the moment of use.** Combined with the harness-agnostic substitution in §2, the
market is "teams using a coding agent," not "teams using this CLI."

### 5.10 Untrusted-code execution — **gated, do not sell yet**

Evaluating third-party or model-generated code, security research, competitive analysis.
The lifecycle fits perfectly; the isolation does not. Docker networks plus bind mounts of
the user's repo root are not a containment boundary. Viable only after the microVM
substitution in §2, and until then the word "sandbox" in the tool's name should not be
read as a security claim.

## 6. M — Modify / Magnify / Minify

- **Minify — remove k8s.** A single-repo, single-service mode with no cluster, no
  `kubectl`, no forward table. Today the prerequisite table (Docker Desktop, kubectl, a
  live cluster, a corporate CA, `/etc/hosts` entries, a setup wizard) is a wall that every
  use in §5 hits before it reaches value. This is the single largest market unlock in the
  document and it is subtraction, not construction.
- **Magnify — a slot pool that is not one laptop.** 12 slots on an M2 becomes 200 on a
  shared host or a cloud pool. This is the SaaS shape of §5.1 and §5.2.
- **Modify the unit of ephemerality.** Workspace-per-feature → per-PR, per-incident,
  per-prospect, per-customer-bug. The lifecycle does not care what the unit means.
- **Magnify the edge alone.** Caddy plus the selector UI, unbundled, is a standalone
  "which environment am I talking to right now" tool with an audience far wider than
  people who want the whole orchestrator.

## 7. E — Eliminate

Ordered by market impact, and note that all of these are deletions:

1. **The k8s dependency** (see Minify — the gating item).
2. **The macOS / Docker Desktop assumption** — blocks Linux hosts and CI runners, which
   is where §5.1 and §5.2 actually want to run.
3. **The one-machine ceiling** — see Magnify.
4. **The setup wizard as a required step.** Onboarding cost is the growth blocker; a
   zero-config default path matters more than any feature below it.
5. **The Claude Code coupling in the skills layer** — make the standards loader
   harness-agnostic (see §2, §5.9).

## 8. R — Reverse / Rearrange

- **Reverse the delta.** Instead of "my changes against a live baseline," run "the
  baseline against live traffic" → shadow / dark-launch testing.
- **Reverse the routing direction.** Today the developer's browser is routed to their
  slice. Invert it and route a sampled percentage of *production* traffic to a candidate
  slice → progressive delivery, with P2 unchanged.
- **Invert what is ephemeral.** Today: ephemeral workspaces, persistent cluster. Inverted:
  persistent workspaces, ephemeral baselines — branch-per-environment.
- **Reverse the standards flow.** Today standards flow to the agent. Reversed: observe
  what agents get wrong across many workspaces and auto-propose new standard modules. The
  existing graduation flow is the manual version of this; the automated version is a
  compounding asset that improves with usage — the strongest long-term moat here.
- **Rearrange graduation timing.** Move it from `down` to continuous, so every workspace
  feeds a standing knowledge base instead of a teardown prompt.

---

## 9. Where this lands

**Pursue three, not twelve:**

1. **§5.1 Agent evaluation harness** — unique assets, real buyers, and the hardest for
   anyone else to reproduce.
2. **§5.3 Governance evidence** — nearly free from what already exists, and it reaches a
   budget that dev tools cannot.
3. **§5.9 Standards distribution, harness-agnostic** — the largest audience, and the repo
   has already been factored for it.

**§5.2 (preview environments) is the obvious commercial answer and probably the wrong
one** — the machinery fits best, but it is a contested category against funded incumbents,
and it would be entered on price against products that already run in the cluster.

**One prerequisite gates all of it: §7.1–7.4.** Nothing above survives contact with a
prerequisite table demanding kubectl, a live cluster, a corporate CA, and hosts-file edits.
The market-expansion work is deletion before it is invention.
