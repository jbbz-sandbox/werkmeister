# Using the JIT context system — operating practices

> **Not normative.** The binding rules live in the `sb-*` phase skills
> (`apps/cli/infra/skills/`), which are what an agent actually loads; this file is
> the *why* behind them, for whoever maintains those skills. Where the two
> disagree, the skill wins and this file is stale.
> **Companion docs:** [jit-context-system.md](jit-context-system.md) is the design
> spec (the *what to build*); [context-management-research.md](context-management-research.md)
> is the research trail. This is the *how to work inside it*.
> **Evidence:** distilled from `.werkmeister/notes/082-finding-session-cost-savings-and-the-discovery-tax.md`,
> which measured one session's context spend.

Context is a budget, and the expensive failure is not running out — it is
**degradation**: rules loaded early drift into low-attention middle context and
stop steering generation.

## 1. Load at the phase gate, before the first generation pass

Prevention rules only work if they are in context **before** the first token of
generated code. Loading a standard after code exists is too late — the model is
then reviewing rather than being steered, which is a weaker mechanism.

This is why `sb-implement` must run before the first `Edit`/`Write` of a session,
not after a draft exists.

## 2. Load only what the phase needs

`sb-research` explicitly forbids loading `sb-*-standard` skills and `ponytail`:
they govern *writing* code, the phase is read-only, and loading them there both
wastes budget and weakens the phase gate. Symmetrically, `sb-implement` loads the
universal base plus **only** the domain standards whose "Loads on" patterns match
the files about to be edited.

Re-check on each new file type. Starting on `.ts` service code and later touching
a `.tsx` means loading `sb-ui-standard` **at that point** — not retroactively.

## 3. Re-anchor at the edit site (the lost-in-middle problem)

A rule loaded twenty tool-calls ago is in the dead middle of the window, where
attention is weakest. Phase-entry loading alone therefore decays over a long
session.

**The countermeasure is recitation:** before writing code on a standard-governed
path, restate the one-line rule from its STANDARD.md next to the edit. Moving the
rule adjacent to the generation is what makes it bind.

## 4. Keep tool output out of the window

Tool outputs dominate long trajectories. A full test/build/typecheck dump buries
the standards loaded at phase entry under thousands of low-signal tokens.

    npm test > /tmp/check.log 2>&1; echo "exit=$?"
    grep -nE '✖|✗|×|npm error|Tests.*failed' /tmp/check.log

Read back only the failing slice. **Trust the exit code** — it is the cheapest
signal available, and a zero exit needs no grep at all. Make the grep specific:
a loose `-i 'fail|error'` matches test *fixture strings* and manufactures the
noise it was meant to avoid (see note 082 §3). Measured on this monorepo: 158
matches on a passing run, versus 0 for the pattern above.

Match the runners, not the word "fail" — node:test marks failures with `✖`,
vitest with `✗`/`×`, npm with `npm error`. The wrong glyph is worse than the
noise: it reports a clean run on a suite that failed.

## 5. Delegate fan-out; read what you reason against

> Normative home: `sb-research`, "Read what you reason against".
> This was the one practice here that no skill encoded; it does now.

Subagents keep exploration bulk out of the parent window and return a conclusion
plus a note path. The dividing question is **do I need the evidence, or just the
answer?**

- **Delegate:** broad searches whose file dumps are throwaway — "who imports X",
  "every file matching this convention", "does any test cover Y".
- **Read inline:** `decision` notes (binding, and precedence turns on exact
  wording), the body of a function whose behaviour is a safety argument, a rule
  about to be applied.
- **Verify the pivot point firsthand** when a delegated conclusion becomes
  load-bearing for shipped code.

Delegation is not free: it trades tokens for a layer of indirection between you
and the evidence. Spend it where the evidence is genuinely disposable.

## 6. Persist decisions at the moment they settle

Write the `decision`/`attempt`/`contract` note **when the decision settles**, not
at session end — by then the "why" has often already been compacted away. Notes
are the durable memory that outlives the window; the window is not the memory.

Corollary: **notes only pay off if they are read.** Twice in this repo's history
(076 and 077) a question was re-investigated that
`037-finding-step-5-api-shape-and-split.md` had already answered a month earlier.
Before investigating, grep the ledger for the question.

## 7. Respect `status:` in note frontmatter

`status: superseded` means **do not read the body** — it names its replacement.
Both `sb-implement` step 3 and `sb-research` step 0 say so. Reading a superseded
8KB handoff for content already restated in its successor is pure waste.

## 8. Bound the investigation

Prefer the smallest investigation that answers the question with adequate
confidence. Three files that answer it beat thirty that surround it. If an
investigation balloons past its budget, stop and report what you have plus what
is still open, rather than silently spending more.
