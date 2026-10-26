# Why Werkmeister

> The origin story, vision and mission, in the voice of its one contributor.
> Source for the landing page's "why" section and anything that introduces the project.

## Vision

**A world where a developer's day is spent on judgment and craft, not toil.**

Software is written, tested, wired up, deployed and verified by agents that never
skip a step. People are where the decisions are: what to build, whether it is
right, and when it ships.

## Mission

**Make the agent do the work and the person do the deciding.**

Werkmeister runs many pieces of work at once, each in its own isolated workspace
with its own workflow for its kind of work, and gates the places where only a
person can decide.

## Why statement

> I believe the most valuable thing a developer brings is judgment. I built
> Werkmeister so that judgment is the only thing you have to bring.
>
> More time to do the things that humans are good at.

## How it started

It started with a time difference.

Our company opened an office in Pune, India, and we were hiring to fill it. Lots
of new developers, every one of them needing a working environment before they
could write a line of code.

Getting one took days. A new engineer spent two or three of them wiring up about
ten local containers, and no two environments came out the same. Their morning
was my evening, and their evening was my early morning, so every snag landed in
one or the other. I was walking people through setup one at a time and burning
the candle at both ends.

I didn't want a better onboarding doc. I wanted one command that brought
everything up, so nobody needed me awake for it.

The hard part was what *not* to run. Nobody needs the whole platform on their
laptop. You need the services you're about to change, and everything else should
come from the shared environment that's already running. So that became the
rule: run locally only what you change, and defer the rest to remote.

Setup went from days to about thirty minutes, and from ten containers to one to
three. Everyone started from the same baseline, and the drift stopped.

The team called the tool the developer sandbox. It ran one environment at a
time, for the feature you were working on right then. Switching to a bug fix
meant tearing that down, bringing up another, and finding your place again when
you came back. Context switching was hard because the tool made you pay for
every switch.

So it grew: from one environment for the feature in progress to many features at
once, each with an agent doing the work. That's Werkmeister.

Also on my blog: [How Werkmeister started](https://jaysonboyer.github.io/blog/werkmeister-origin/).

## The story

I used to skip the tests.

Not always. Not proudly. But when the feature was done and the day was gone, the
unit test, the functional test, the integration test were the first things to
fall off the end. I'd tell myself I'd circle back. Anyone who's shipped software
knows how that ends.

Then something changed, and it wasn't my discipline. The tests get written now.
All three kinds. Not because I found more hours, but because the writing is no
longer on me. The work that used to compete with my judgment now runs beside it.

A friend asked me recently what Werkmeister actually is. I said this: I log
bugs, Claude logs bugs, and I'm managing the work as it's building itself. Wild.

That's the whole thing. Development is no longer the bottleneck. I am. And that
turns out to be exactly where I want to be.

## What I believe

Every team has more work than hands, and the reflex is to make the hands faster.
I think the hands were never the problem.

The problem is that one person was asked to do everything. Reproduce the bug.
Propose the fix. Implement it. Wire up the environment. Deploy it. Verify it in
production. And then, with whatever attention was left, decide whether any of it
was right.

Deciding is the job. Everything else is in the way.

So I asked a different question. If the typing, the testing, and the plumbing
ran on their own, where would a person still need to be? Not everywhere. Not
nowhere. Somewhere specific.

I believe the answer is a gate. A place where the work stops and waits for a
human, and only a human.

## How it works

Not all work is the same work. A bug has a shape: reproduce it, propose a fix,
implement, deploy, verify. A spike has a different shape. A feature, a refactor,
a documentation pass, each one has its own stages. Werkmeister gives each work
type its own workflow, and runs them side by side in isolation.

So you start a wave. It pulls the tickets from Jira, builds a workspace for each
one with its own git worktree and its own generated compose, and the agents get
to work. You're not watching them. You're watching a panel that tells you which
workspace needs you. When an agent hits a question or a hard gate that needs
approval, it says so. When it doesn't, it doesn't ask.

Autonomous where it can be. Human where it must be. Ten things at once, and your
attention goes only where a decision lives.

## What it is

Werkmeister is a multi-feature concurrent development orchestrator. That's the
what, and it's the least interesting part.

The interesting part is the day it gives you back. The tests exist. The
environment comes up. The branches don't collide. And you spend your time on the
one question no agent can answer: is this right?

## Where it stands

I built this alone, for myself, because I needed it. It's open. The docs need
work. And before I write a "find it and start on your own" milestone into the
roadmap, I want to sit with a few people, watch them fumble around, and learn
what's intuitive and what's friction.

If that's you, let's pair up. Not because I need users. Because I want to find
out whether this is useful to anyone but me. If it is, the "we" starts there.

## The name

Not part of the story. For an "About" or FAQ block, or a footnote on the landing page.

**Werkmeister** is German for a works foreman: the person in charge of a workshop
floor. Said roughly VAIRK-my-ster.

A foreman doesn't build the thing. They run the building of it. They know what
every bench is working on, hand out the next job, walk the floor, and step in
when a decision needs someone who can see the whole shop. That is what this tool
does for each feature, and the gates are the foreman's walk.

The short command is `w9r`: w, nine letters, r, the same way k8s stands for
Kubernetes.

Why not an English word: every English name for the person in charge (foreman,
conductor, dispatcher, marshal, overseer) is already a developer tool or a
well-known package. The tool was called `sandbox` for its first year. That word
can't be searched for, and a competitor uses it for their own unit of work, so it
had to go before the project went open source. The full search, with every
candidate and why it lost, is in [naming-research.md](naming-research.md).

## Notes on voice

- First person throughout. There is one contributor, and a belief owned by a
  named person is more credible than one claimed by an invisible team. When a
  second contributor lands, "Where it stands" is the only section to rewrite.
- Why first, how second, what last. The product description is deliberately the
  shortest section.
- The opener is a confession. Read it once as a stranger before it goes under
  your name on the site.
- The origin and the confession are two stories. The origin says why the tool
  exists; the confession says what it changed. Keep them in that order.
