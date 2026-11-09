---
layout: home
hero:
  name: Werk|meis|ter
  ipa: "[ˈvɛʁkˌmaɪ̯stɐ]"
  said: VAIRK-my-ster
  grammar: "<i>m</i> -s, -"
  senses:
    - foreman; the one who runs the building of the thing, not the one who builds it.
    - "<i>(Comput)</i> <code>w9r</code>: runs many pieces of work at once, each in its own workspace, and stops only where a person has to decide."
  etymology: "<i>German</i>, from <b>Werk</b> work (<i>Old High German</i> werc, akin to English <i>work</i>) + <b>Meister</b> master (<i>Old High German</i> meistar, from <i>Latin</i> magister)"
  note: "A foreman doesn't build the thing. They run the building of it. They know what every bench is working on, hand out the next job, walk the floor, and step in when a decision needs someone who can see the whole shop. That is what this tool does for each feature, and the gates are the foreman's walk."
  text: Autonomous where it can be. Human where it must be.
  tagline: "One agent per ticket, each in its own git worktree and containers. Bring your harness (Claude Code, OpenCode or Codex), any OCI container manager, and your tracker (Jira, GitHub Issues, or your own)."
  actions:
    - theme: brand
      text: Get started
      link: /docs/quick-start
    - theme: alt
      text: GitHub
      link: https://github.com/jbbz-sandbox/werkmeister
features:
  - title: A workflow for each kind of work
    details: A spike, a feature, a refactor each get their own stages.<br>A bug gets reproduce → fix → exercise → propose.
  - title: Many at once, in isolation
    details: Each ticket gets its own workspace, git worktree, containers and routing, side by side without collisions.<br><code>X-Feature=checkout-retry</code> on <code>frontend.local.werkmeister.io</code> reaches that workspace's containers.
  - title: Gates where judgment lives
    details: Agents run on their own and stop only where a person has to decide, so your attention goes where a decision is.<br>“Should the facet panel collapse on phone widths?” waits for you.
---

## Why

> I believe the most valuable thing a developer brings is judgment. I built
> Werkmeister so that judgment is the only thing you have to bring.
>
> More time to do the things that humans are good at.

It started with a time difference. Our company opened an office in Pune, India,
and we were hiring to fill it. Lots of new developers, every one of them needing
a working environment before they could write a line of code.

[Read how it started →](/docs/why#how-it-started) <!-- docs-check: ignore (a site route: this page is served at /, not apps/docs-site/) -->
