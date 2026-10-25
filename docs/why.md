# Why Werkmeister

> The origin story, vision and mission, in the voice of its one contributor.
> Source for the landing page's "why" section and anything that introduces the project.

## Vision

**A world where a developer's day is spent on judgment, not toil.**

Software is written, tested, wired up, deployed and verified by agents that never
skip a step. People are where the decisions are: what to build, whether it is
right, and when it ships.

## Mission

**Orchestrate autonomous development that stops exactly where human judgment is
required.**

Werkmeister runs many pieces of work at once, each in its own isolated workspace
with its own workflow for its kind of work, and gates the places where only a
person can decide.

## Why statement

> I believe the most valuable thing a developer brings is judgment. I built
> Werkmeister so that judgment is the only thing you have to bring.
>
> More time to do the things that humans are good at.

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

## Alternate why lines

For the hero, a tagline, or a README first line:

- Judgment is the only part of software that can't be automated. Werkmeister is built around it.
- Confidence shouldn't be the thing you trade for speed.
- Autonomous where it can be. Human where it must be.
- Development is no longer the bottleneck. You are. That's how it should be.

## Alternate vision and mission lines

Vision:

- Every developer's day spent on the decisions only a human can make.
- Software that builds itself, with people at the gates.

Mission:

- Give each kind of work its own autonomous workflow, run them in isolation side by side, and put a human gate exactly where one belongs.
- Make the agent do the work and the person do the deciding.

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
