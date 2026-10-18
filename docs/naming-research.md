# Naming Research — Renaming the sandbox Tool for Open Source

> **Decision (2026-10-17): Werkmeister, with `w9r` as the short command.** Reasons are in
> section 7.8; the rename itself is tracked as an epic in the SW Jira project.
> Research done 2026-10-12; section 7.8 added 2026-10-17. Registry and web results are
> as of those dates; names get claimed, so re-check anything here before relying on it.

---

## 1. Why the tool needs a new name

The tool is being prepared for open source. Two problems with "sandbox" came up:

- **It cannot be searched.** "Sandbox" is a common word in software, so a search for it
  will not find this project.
- **It overlaps with a competitor's vocabulary.** Signadot, a paid product that does
  nearly the same job (it runs only the changed services and routes requests by header),
  calls its unit of work a "Sandbox". A tool named "sandbox" would read as related to
  Signadot or as a copy of it.

## 2. What the name should describe

Taken from [sandbox-architecture.md](sandbox-architecture.md) and
[users-guide.md](users-guide.md), the facts a name could point at are:

1. **Only changed services run locally.** Each feature runs on the laptop only the
   services whose code it changed. Everything else is reached through port-forwards to the
   shared Kubernetes cluster (the "baseline").
2. **Many features run at once.** Up to 12 features (and so up to 12 Claude Code agents)
   run side by side on one machine, each with its own Docker network and port range.
3. **A per-request choice.** Caddy, the proxy, reads the `X-Feature` cookie on each
   request and sends it to that feature's local copy of a service, or to the baseline
   when the feature has no local copy.

The tool's own unit of work is already called a "feature" (`X-Feature`, "concurrent
features").

## 3. What we want from a name

These came out of the discussion. They are preferences, not fixed rules.

- **Memorable and says what the tool does** (the original request).
- **Free as a package name**, at least on npm, where the CLI is published.
- **No existing product with the same name in developer tools.** A clash in an
  unrelated field (cosmetics, cars, research papers) matters less.
- **Searchable.** A search for the name should be able to find the project.
- **Easy to say and spell** for English speakers.
- **German is welcome.** The owner likes German words.
- **No negative connotation** (added 2026-10-17). A name must not suggest manipulation,
  crime, being sidelined or a mess, in English or in German. This one is a hard rule,
  not a preference.
- **A short numeronym as the command** (see section 6). A numeronym is a word shortened to
  its first letter, the number of letters in between, and its last letter:
  "Kubernetes" → k8s, "internationalization" → i18n, "accessibility" → a11y.

## 4. How names were checked, and what could not be checked

### Checks that worked

| Check | What a result means |
|---|---|
| **npm** (`registry.npmjs.org/<name>`) | 404 = no package with that name. 200 = taken. |
| **PyPI**, the Python registry (`pypi.org/pypi/<name>/json`) | Same. |
| **crates.io**, the Rust registry (`crates.io/api/v1/crates/<name>`) | Same. |
| **Go module mirror** (`proxy.golang.org/github.com/<name>/<name>/@latest`) | 200 = Go has a copy of a GitHub repository at that address, so the GitHub account existed. 404 does **not** prove the GitHub name is free: the mirror only knows repositories someone has downloaded through Go. |
| **Docker Hub** (`hub.docker.com/v2/users/<name>/`) | 404 = no account. |
| **Web search** | Finds products and projects already using a name. It cannot prove a name is unused. |

### Checks that were blocked

The network policy of the cloud environment this research ran in refused these. The
results are unknown, not negative.

- **Domains.** The registration lookup service (`rdap.org`) was refused.
- **GitHub account names.** Direct requests to GitHub returned 403 for every name,
  including made-up ones.
- **Trademark registers.** Not searched: USPTO (US), EUIPO (EU), DPMA (Germany).

To check these by hand:

- GitHub: open `https://github.com/<name>`. "404 – page not found" means it is free.
- Domains: search the name at <https://lookup.icann.org> or on any domain seller's site.
- Trademarks: <https://tmsearch.uspto.gov> (US) and <https://www.tmdn.org/tmview> (EU and
  many national registers, including Germany's).

## 5. Similar tools

A new name should be distinct from these. All do some part of the same job.

| Tool | What it does |
|---|---|
| **Signadot** | Paid. Deploys only changed services into a "Sandbox" and routes requests to them by header, everything else goes to the shared baseline. |
| **mirrord** | Connects a process on the laptop to a remote Kubernetes cluster's traffic. |
| **Telepresence** | Intercepts a cluster service's traffic and sends it to the laptop. This tool already uses it (`sandbox intercept`). |
| **Okteto**, **Gefyra**, **DevSpace**, **Tilt**, **Skaffold**, **vcluster** | Other Kubernetes development tools. |
| **Razorpay Devstack** | Open source. Feature-level routing by header propagation. Needs AWS, Traefik, Helm and LocalStack. |
| **LocalStack** | Emulates AWS on the laptop (see 7.3). |

## 6. Numeronyms as the command

- A numeronym only works when people already know the full word. Nobody guesses
  "Kubernetes" from "k8s", but anyone who knows Kubernetes recognises it. So the plan is
  two names: a full name for the project, and the numeronym as the command.
- **Correction recorded during research:** "k8s" is mostly a written nickname. The
  Kubernetes command is `kubectl` (per kubernetes.io). The spelling matters for the count:
  "Kubernetes" has one t; with two it would be k9s, which is a separate, popular terminal
  UI for Kubernetes.
- **Precedent for a numeronym as the real command:** K3s (a small Kubernetes) is run as
  `k3s server`, and K9s is run as `k9s`.
- **Similar-looking numeronyms are a problem.** s6k, s7t, s8k differ by one digit and one
  letter. n8s differs from k8s by one letter and would read as a Kubernetes spin-off.
- **English versus German.** Fitting English words are ordinary words, which are already
  taken as packages and cannot be searched. For those, the numeronym has to be the
  searchable form, which reverses how k8s works (there the full word is the rare one).

## 7. Names explored, in the order they came up

### 7.1 First round: English compounds

npm results for a first batch of ideas:

- **Free:** diffstack, splitstack, featurelane, graftstack, lanestack, slicebay,
  stacksplice, partstack, swapstack, deltabox, splicekit, cutover, stackslice,
  baseline-overlay.
- **Taken:** splicer, patchbay, laneway, overlane, forklane, understudy, slicer, lanes.

Shortlist from this round:

| Name | Literal meaning | Findings |
|---|---|---|
| **diffstack** | "Diff" = a set of code changes; "stack" = all the services an app runs on. Run only the changed part of the stack locally. | Free on npm and PyPI. AWS has an internal test function called `diffStack`. "Stacked diffs" is an unrelated Git workflow (Graphite, `glab stack`), so some developers may at first misread it. **Later found:** NVIDIA's research lab publishes an open-source project called DiffStack (`github.com/NVlabs/diffstack`), research code from a 2022 paper on self-driving car control. Different field, but it would come first in searches. The numeronym d7k is taken on npm. |
| **splitstack** | The stack is split: changed services on the laptop, the rest in the cluster. | Free on npm and PyPI. "Split stacks" is a GCC compiler feature; Split.io is a feature-flag company. Numeronym s8k is free on npm, PyPI and crates.io. |
| **featurelane** | Each feature gets its own separate, parallel set of resources. | Free on npm. Nothing found. Says nothing about "only what changed". |
| **graftstack** | To graft = to attach a new piece onto something already running. | Free on npm. Nothing found. Less familiar word. |

### 7.2 Mystack

Ruled out.

- "My stack" is an everyday developer phrase (the tools one uses). Searches return
  StackShare "My Stack" pages, Myappstack (a business software product), and MStack (an
  HP calculator utility), so the name would not be searchable.
- npm has a `mystack` package: no description, last changed August 2024. Free on PyPI.
- It does not describe what the tool does.

### 7.3 LocalStack

Ruled out.

- LocalStack is a funded company (TechCrunch reported a $25M raise in November 2024;
  headquarters given as Zurich). Its product emulates AWS on a developer's machine, runs
  in Docker, and has a free open-source edition and paid editions. An analyst report
  (Intellyx, November 2025) cites 400 million Docker image downloads.
- `localstack` is taken on PyPI (by LocalStack) and on npm.
- Same field as this tool. Razorpay Devstack, one of the similar tools, lists it as a
  requirement. A trademark is likely; not verified.

### 7.4 German railway names

The per-request choice (fact 3 in section 2) matches railway vocabulary for sending each
train onto a track.

| Name | Pronunciation | Literal meaning | npm | PyPI | Findings |
|---|---|---|---|---|---|
| **Stellwerk** | SHTEL-vairk | Railway signal box: the building where switches and signals for an area are set | free | free | Ruled out after a deeper check, see 7.5 |
| **Stellpult** | SHTEL-poolt | The control desk inside a signal box | free | free | Also free on crates.io and Docker Hub; no Go-mirror repository. Not web-searched. Numeronym s7t: free in all three registries, but Siemens sells a paid package called "S7T" for its S7 factory controllers (2013 forum thread) |
| **Weichenwerk** | VY-khen-vairk | "Switch works": Weiche (track switch) + Werk (works). A made-up compound | free | free | Also free on crates.io and Docker Hub. Not web-searched. Numeronym w9k free in all three registries |
| **Spurwerk** | SHPOOR-vairk | "Track works": Spur (track, lane) + Werk. "Spur" is also English for a railway branch line | free | free | Also free on crates.io and Docker Hub. Numeronym s6k free |
| **Abzweig** | AHP-tsvyke | Where a side line splits off the main line | free | free | Nothing found. Numeronym a5g free |
| **Nebengleis** | NAY-ben-glice | A side track next to the main line | free | free | Nothing found. Numeronym n8s free, but looks like k8s. **Ruled out for connotation:** "aufs Nebengleis geraten" means to be sidelined |
| **Weiche** | VY-kheh | A track switch | free | **taken** | PyPI name belongs to a Deutsche Bahn train-connection lookup tool |
| **Baustelle** | BOW-shtel-leh | Construction site | free | free | Nothing found. Numeronym b7e free. **Ruled out for connotation:** in everyday German "eine Baustelle" is an unsolved problem or a mess |
| Zweig | | Branch | free | taken | Not pursued |
| Umleitung | | Detour | free | taken | Not pursued |
| Gleis | | Track | taken | free | Not pursued |
| Werkbank | | Workbench | taken | taken | Not pursued |
| Spur | | Track | taken | taken | Not pursued |
| Ableger | | Plant cutting | free | free | Not pursued |

### 7.5 Stellwerk, deeper check

Ruled out. Free on npm and PyPI, but:

- **An AI-agent tool has reserved the name.** On 2026-09-21, crates.io received a 0.0.0
  placeholder package `stellwerk` described as "Reserved for the Stellwerk project
  (autonomous agent control plane). Work in progress." It links to
  `github.com/tensorov/stellwerk`, which could not be opened (private or not yet created).
  Web searches found nothing about the project. An empty 0.0.0 package is how people hold
  a name before a launch, so an AI-agent tool called Stellwerk is probably coming. This
  tool manages AI coding agents, so the two would be confused.
- **The GitHub name is probably taken.** The Go mirror holds a repository at
  `github.com/stellwerk/stellwerk`, last changed April 2015.
- **Docker Hub:** a personal `stellwerk` account, created November 2025, empty.
- **Other uses:** STELLWERK Consulting AG (Cologne, 11–50 employees, SAP consultancy that
  also sells software); Stellwerk easy (model-railway control software, discontinued
  February 2022); a Swiss online school-skills test called Stellwerk (St. Gallen);
  TauStellwerk (hobby model-railway project on GitHub).
- **Numeronym s7k** (9 letters: s + 7 + k): free on npm, PyPI, crates.io and Docker Hub;
  no Go-mirror repository at `s7k/s7k`. This does not change the verdict: a numeronym is a
  shortcut for a full name people already know, and the full name is what clashes. s7k
  also looks like s7t (Stellpult), and starts with "S7", the name of Siemens' S7 line of
  factory controllers.
- **Re-check 2026-10-17** (from a local machine, where GitHub could be reached): the
  crates.io placeholder is still there; `github.com/tensorov/stellwerk` returns 404.
  `github.com/stellwerk` and `github.com/s7k` both exist, so neither account name is
  available. npm `stellwerk` and `s7k` and PyPI `stellwerk` are still free. The owner
  keeps Stellwerk as an option despite the clash; the repository could live at
  `jbbz-sandbox/stellwerk` without a matching account.

### 7.6 English numeronym round

Long English words that describe the tool. Every full word is taken as a package on at
least one registry (most on all three). Numeronym results:

| Word | Literal meaning, and the match | Command | Numeronym free? | Existing software found |
|---|---|---|---|---|
| **Multiplex** | Send several separate signals over one shared line at once. Many features share one laptop, one proxy and one set of hostnames; the `X-Feature` cookie tells them apart | m7x | yes, all three | No developer tool called Multiplex. "m7x" found only microchip part numbers. Developers know the word from tmux ("terminal multiplexer") |
| **Concurrency** | Several things running at the same time. The README calls the tool a "multi-feature concurrent development orchestrator" | c9y | yes, all three | Not searched. Standard programming term, so the full word cannot be searched |
| **Junction** | Where railway lines or roads meet and split | j6n | yes, all three | Not searched |
| **Switchyard** | A railway yard with many switches, where trains are sorted onto tracks | s8d | taken on npm | Crowded: a Rust AI-request router (close field), Red Hat JBoss SwitchYard (old), a Python networking framework |
| **Signalbox** | English for Stellwerk | s7x | yes, all three | SignalBox.sh, a developer-tools phone app (March 2026), same audience |
| **Roundhouse** | Railway building where locomotives are parked side by side around a turntable | r8e | yes, all three | RoundhousE, a .NET database migration tool |
| Crossover | | c7r | yes | Not searched |
| Interleave | | i8e | yes | Not searched |
| Partition | | p7n | yes | Not searched |
| Manifold | A pipe that splits one flow into many outlets | m6d | yes | Not searched |
| Switchboard | | s9d | yes | Not searched |
| Dispatcher | | d8r | taken on npm | Not searched |
| Sidecar | | s5r | yes | Not searched. "Sidecar" is already a common Kubernetes term |
| Shunting | Moving railway cars between tracks | s6g | taken on npm | Not searched |
| Siding | A short side track | s4g | taken on PyPI | Not searched |
| Marshalling | Sorting railway cars into trains | m9g | taken on PyPI | Not searched |
| Turnout | English railway term for a track switch | t5t | taken on npm | Not searched |

### 7.7 Featureplex / f9x

The owner's idea, a made-up compound: "feature" (the tool's own unit of work) + "-plex"
(from multiplex: many units in one shared place). Literally, many features running side
by side through one shared system. 11 letters, so the numeronym is f9x.

| Check | featureplex | f9x | feature-plex |
|---|---|---|---|
| npm | free | free | free |
| PyPI | free | free | free |
| crates.io | free | free | free |
| Go mirror (GitHub repository) | none | none | none |
| Docker Hub | free | free | free |

Web search:

- **Featureplex:** the only exact match is "FeaturePlex Bleach", a hair-bleach product
  sold in a kit by the cosmetics brand Bleach London. Different field; trademarks are
  registered per category of goods. Trademark status not checked. Near matches: Plex (a
  popular media-streaming app, also software; small chance of being read as a Plex add-on),
  Googleplex, cinema multiplexes.
- **f9x:** no exact match. Nearest is Infor's "F9", an Excel financial-reporting add-in.

As of this research, the clearest candidate checked. Unlike the common English words,
both the full name and the numeronym can be searched. Domains, GitHub names and
trademarks are not checked.

### 7.8 Puppet master, boss and controller names

Added 2026-10-17. The owner liked the "master controller" idea behind Stellwerk: one
place that pulls the strings for many features and agents. This round tried "puppet
master" in English and German, then other words for a boss, a foreman or a control
centre.

This round ran from a local machine, so two checks that were blocked in section 4
worked: **GitHub** (`github.com/<name>`: 200 = an account or organisation with that name
exists) and Docker Hub. Domains and trademarks were still not checked.

#### English: all taken

| Name | npm | PyPI | crates.io | Findings |
|---|---|---|---|---|
| **Puppetmaster** | free (`puppet-master` taken) | free (`puppet-master` taken) | taken | **Ruled out.** "Puppet master" was the name of the central server in Puppet, the configuration-management tool; its daemon was `puppetmasterd`. Same field (infrastructure tooling) |
| **Puppeteer** | taken | free | taken | **Ruled out.** Google's headless-Chrome library, very widely used |
| **Marionette** | taken | taken | taken | **Ruled out.** Firefox's browser-automation protocol has this name |
| Ringmaster, Mastermind, Overseer, Foreman, Taskmaster, Showrunner, Quartermaster, Maestro, Overlord, Helmsman | taken | taken | taken | Not pursued. Several are existing developer tools (Foreman, a Procfile process runner; Maestro, a mobile UI-testing tool; Helmsman, a Helm-chart tool), known from prior knowledge, not re-searched |
| **Switchman** | taken | free | free | **Weakened.** English for Weichensteller, the railway worker who sets each switch; fits the per-request choice. npm `switchman` is "the simplest tool to switch env configs" (last changed September 2022), a near neighbour in purpose. RubyGems `switchman` is Instructure's database-sharding gem for Rails (about 1.9 million downloads). GitHub `switchman` exists; Docker Hub taken. Numeronym s7n is free on npm, PyPI, crates.io and Docker Hub, taken on RubyGems, and looks like s7k, s7t and s7x. Gendered word ("-man"), which some open-source projects avoid |
| Ringleader, Majordomo, Impresario, Kingpin | taken | mixed | mixed | Not pursued. Ringleader, Kingpin, Mastermind, Overlord and Taskmaster also fail the connotation rule (crime, domination, harshness) |

#### German: puppet master

**All ruled out for connotation.** German has an idiom for the person who pulls the
strings behind the scenes: the *Strippenzieher* or *Drahtzieher*. It means the same as
"puppet master" in English, and like the English it suggests manipulation, often of a
crime or a plot. The literal translations (Puppenmeister, Puppenspieler) carry the same
sense of controlling people. Registry results are kept so nobody re-checks them.

| Name | Literal meaning | npm | PyPI | crates.io | Docker Hub | GitHub | Command | Why ruled out |
|---|---|---|---|---|---|---|---|---|
| Drahtzieher | "Wire-puller" | free | free | free | free | taken | d9r (taken on npm) | Usually said of the ringleader of a crime |
| Strippenzieher | "String-puller" | free | free | free | free | taken | s12r | Someone manipulating events from behind the scenes |
| Fadenzieher | "Thread-puller" (Swiss usage) | free | free | free | free | free | f9r | Same idiom as Strippenzieher |
| Puppenmeister | Puppet master | free | free | free | free | taken | p11r | Controlling people; also "Puppen" sounds like "poop" in English |
| Puppenspieler | Puppeteer | free | free | free | free | taken | p11r | Same as Puppenmeister |

#### German: boss and control centre

| Name | Pronunciation | Literal meaning | npm | PyPI | crates.io | Docker Hub | GitHub | Command | Findings |
|---|---|---|---|---|---|---|---|---|---|
| **Weichensteller** | VY-khen-shtel-ler | Switchman: the railway worker who sets each track switch so a train goes the right way. The closest match to the per-request choice (fact 3 in section 2) | free | free | free | free | taken | w12r — free everywhere, GitHub included | Web search found no software with this name. Long: 14 letters |
| **Werkmeister** | VAIRK-my-ster | Works foreman: the person in charge of a workshop floor | free | free | free | free | taken | w9r — free everywhere, GitHub included | Web search found only unrelated tools named "werk" (a Ruby gem, Checkmk's change-log script, a Crystal task runner) |
| **Schaltzentrale** | SHALT-tsen-trah-leh | Control centre; also "nerve centre" in the figurative sense | free | free | free | free | taken | s12e — taken on Docker Hub | Web search found no software with this name. Long: 14 letters |
| **Leitstelle** | LITE-shtel-leh | Dispatch centre, for example for emergency services or a transport network | free | free | free | taken | taken | l8e — free everywhere, GitHub included | Not web-searched |
| **Taktgeber** | TAHKT-gay-ber | "Beat-giver": the clock in a circuit, or whoever sets the pace | free | free | free | free | taken | t7r — free on npm, PyPI, crates.io, Docker Hub | Not web-searched |
| **Spielleiter** | SHPEEL-lie-ter | Game master; also a stage director | free | free | free | taken | taken | s9r — free on npm, PyPI, crates.io, Docker Hub | Not web-searched |
| **Steuerwerk** | SHTOY-er-vairk | The control unit of a processor | free | free | free | taken | taken | s8k — same as Splitstack | Not web-searched |
| Polier | po-LEER | Foreman on a building site | free | free | free | free | taken | — (6 letters, too short for a numeronym) | Not pursued |
| Zentrale | tsen-TRAH-leh | Head office, central office | free | free | free | taken | taken | — | Not pursued. Everyday word, so it cannot be searched |
| Leitwerk | | Control unit (also an aircraft's tail) | free | taken | free | free | taken | l6k | Not pursued |
| Dirigent, Kapellmeister, Regisseur, Leitstand, Vorarbeiter | | Conductor, bandleader, director, control room, foreman | taken | mixed | mixed | mixed | taken | | Not pursued |

#### Takeaways from this round

- Every English word for a boss or controller is taken and mostly in use by developer
  tools, so English is a dead end here.
- Every "puppet master" word, English or German, fails the connotation rule.
- **Weichensteller** (w12r) fits what the tool does best, but it is long and hard for
  English speakers to say.
- **Werkmeister** (w9r) is easier to say than most and free everywhere except the
  GitHub account name.
- **Leitstelle** (l8e), **Taktgeber** (t7r) and **Spielleiter** (s9r) are free on all
  three package registries but still need a web search.

#### Owner's shortlist from this round

The owner picked four names, and prefers **Werkmeister** because a foreman runs the
building of something, which is what the tool does for each feature. The English
"Foreman" was also considered and is ruled out: The Foreman (theforeman.org) is a large
open-source server-provisioning tool, and `foreman` is a well-known Procfile process
runner.

Domains were checked on 2026-10-17: `.com` and `.dev` through rdap.org, and `.io`
through `whois.nic.io`, because rdap.org has no data for `.io`.

| Name | Meaning | Command | .com | .dev | .io | Web search |
|---|---|---|---|---|---|---|
| **Werkmeister** | Works foreman | w9r | taken | taken (registered April 2025) | free | Only unrelated "werk" tools |
| **Weichensteller** | Railway switchman | w12r | taken | free | free | Nothing found |
| **Leitstelle** | Dispatch or control centre | l8e | taken | free | taken | Nothing found; nearest is Leitstand, a telecom-operations project |
| **Spielleiter** | Game master, director | s9r | taken | free | free | Nothing found; nearest is Spiel, a terminal-presentation framework |

#### Trademark check (2026-10-17)

Searched the USPTO register through its search API (`tmsearch.uspto.gov`) and TMview
(`tmdn.org/tmview`), which covers the EU office (EUIPO), Germany (DPMA), the UK,
Switzerland and most other national registers. Software is Nice class 9 (downloadable
software) and class 42 (software services). This is a screening, not legal advice.

| Name | USPTO (US) | TMview (EU, Germany, others) | Risk for a software tool |
|---|---|---|---|
| **Werkmeister** | No marks; none for the variants Workmeister and Werkmaster either | 27 marks. Live ones: a German hand-tools brand (DPMA, filed 2018; its class 9 covers measuring instruments, safety helmets and spirit levels, not software); building-material and bedding marks (EUIPO and WIPO, classes 17, 20, 24); "Werkmeister System" (medical, classes 10, 41, 44); "Netz-Werkmeister" (DPMA, a figurative mark for business consulting whose class 42 covers only IT consulting); "Webstark Werkmeister" (Paraguay, class 42) | **Low.** Many owners, none in software products. The word is a common German job title, so it is crowded but not owned in this field |
| **Weichensteller** | No marks | 2 marks, both ended: a German one (2025, classes 35, 41, 45) and a Swiss slogan (2009) | **Very low.** Nothing live |
| **Leitstelle** | No marks; the near name Leitstand is registered in class 9 by RtBrick (telecom software) | 18 marks containing the word. **"Leitstelle Deutschland" was filed at the DPMA in June 2026 for classes 9, 41 and 42** (pending). Also live: "Tino 24/7 Ihre digitale Leitstelle für Tiernotdienste" (classes 9, 42) and "EDV-Leitstellensystem Dalles" (classes 9, 42) | **Medium.** A pending filing in exactly the software classes, and the word is generic in German emergency-dispatch software |
| **Spielleiter** | No marks | No marks | **Very low.** Nothing found |


#### Decision

**Werkmeister (`w9r`)** was chosen on 2026-10-17. It best matches the idea of one place
running the building of each feature, passes the connotation rule, is easy enough for
English speakers to say, has a short command that is free everywhere, and has no
trademark in the software classes. Spielleiter is the fallback if Werkmeister hits a
problem. The cost is that `github.com/werkmeister`, `werkmeister.com` and
`werkmeister.dev` are taken, so the project uses `werkmeister.io` and a repository under
an existing or new organisation.

Names claimed on 2026-10-17: npm package `werkmeister` (0.0.0 placeholder) and the npm
organisation `@werkmeister`. An unscoped npm package `w9r` cannot be published: npm's
typo-squatting filter rejects it as "too similar to existing packages wd, ws, cpr, swr,
xhr, tar". That does not affect the command: the `werkmeister` package can install both
`werkmeister` and `w9r` as commands. Only `npx w9r` will not work; `npx werkmeister` will.

## 8. Summary of every name

| Name | Command | Status | Main reason |
|---|---|---|---|
| sandbox (current) | — | Replace | Cannot be searched; Signadot calls its product "Sandboxes" |
| Featureplex | f9x | **Open — clearest so far** | Free everywhere checked; only clash is a cosmetics product |
| Multiplex | m7x | Open | Fits well; full word cannot be searched |
| Concurrency | c9y | Open | Fits; full word cannot be searched |
| Weichenwerk | w9k | Open | Free everywhere checked; harder to say |
| Stellpult | s7t | Open | Free everywhere checked; minor Siemens S7T overlap |
| Splitstack | s8k | Open | Free on npm and PyPI; minor compiler-term overlap |
| Diffstack | d7k | Weakened | NVIDIA DiffStack research project; d7k taken on npm |
| Abzweig, Spurwerk | a5g, s6k | Open, not pursued | Free; harder to say, or numeronym looks like others |
| Featurelane, Graftstack | — | Open, not pursued | Free on npm; weaker meaning |
| Junction | j6n | Open, not searched | |
| Nebengleis, Baustelle | n8s, b7e | **Ruled out** | Connotation: "sidelined" and "a mess" in everyday German |
| Werkmeister | w9r | **Chosen (2026-10-17)** | Works foreman; free on every registry; GitHub account, .com and .dev taken; .io free; trademark risk low (many marks, none for software) |
| Weichensteller | w12r | **Shortlist** | Switchman; best fit for per-request routing; long and hard to say; .dev and .io free; no live trademarks |
| Leitstelle | l8e | **Shortlist — weakened** | Dispatch centre; free on npm, PyPI, crates.io; .dev free; "Leitstelle Deutschland" filed in software classes in Germany, June 2026 |
| Spielleiter | s9r | **Shortlist** | Game master; free on npm, PyPI, crates.io; .dev and .io free; no trademarks found |
| Taktgeber, Schaltzentrale | t7r, s12e | Open, not searched in depth | Free on npm, PyPI, crates.io |
| Drahtzieher, Strippenzieher, Fadenzieher, Puppenmeister, Puppenspieler | d9r, s12r, f9r, p11r | **Ruled out** | Connotation: German "puppet master" idioms suggest manipulation or crime |
| Puppetmaster, Puppeteer, Marionette | — | **Ruled out** | Puppet's server name, Google's browser library, Firefox's automation protocol; "puppet master" also fails the connotation rule |
| Switchman | s7n | Weakened | npm name is an env-config switcher; RubyGems name is a well-known Rails sharding gem; gendered |
| English boss words (Foreman, Maestro, Overseer, …) | — | **Ruled out** | Taken on all registries; several are existing developer tools (Foreman: theforeman.org and the Procfile runner) |
| Stellwerk | s7k | **Weakened — owner keeps it as an option** | Reserved on crates.io by an AI-agent project; github.com/stellwerk and /s7k taken; npm names still free |
| LocalStack | — | **Ruled out** | Funded company in the same field |
| Mystack | — | **Ruled out** | Everyday phrase; npm name taken; says nothing about the tool |
| Switchyard, Signalbox, Roundhouse | — | **Ruled out** | Existing developer software with the same name |
| Weiche | — | Weakened | PyPI name taken |

## 9. Size of the rename

When a name is chosen, the rename itself is a separate piece of work. At the time of this
research, "sandbox" appears 6,792 times in 374 of the repo's 441 tracked files, including:

- the `sandbox` command and the npm package `werkmeister`
- the `~/.sandbox` machine-config directory
- the `SANDBOX_*` environment variables
- the `/__sandbox` feature-selector path served by Caddy
- the `sandbox-tools` plugin and the `sandbox` marketplace name
- the `sandbox-core` package and the VS Code extension

Changing these all at once breaks existing installs, so the rename needs a period where
the old names keep working.

## 10. Next steps

1. For the names still open, check by hand what this research could not (section 4):
   GitHub account, domains (.com, .dev, .io), trademarks.
2. Claim the GitHub and npm names for the chosen name as soon as it is picked. The
   Stellwerk placeholder on crates.io shows names are being reserved in this field.
3. Continue exploring. Ideas not yet tried: more made-up compounds like Featureplex,
   other German compounds, and web searches for the open names marked "not searched".

## Sources

- [Signadot: Telepresence, mirrord, Okteto alternatives](https://www.signadot.com/blog/telepresence-mirrord-okteto-alternatives/)
- [Signadot vs mirrord comparison](https://signadot.com/comparison/mirrord)
- [Razorpay Devstack](https://github.com/razorpay/devstack)
- [AWS MDAA diffStack function](https://aws.github.io/modern-data-architecture-accelerator/typedocs/functions/_aws-mdaa_testing.diffStack.html)
- [Graphite: stacked diffs](https://graphite.dev/guides/stacked-diffs)
- [GitLab CLI: glab stack](https://docs.gitlab.com/cli/stack/)
- [GCC Split Stacks](https://gcc.gnu.org/wiki/SplitStacks)
- [NVlabs/diffstack on GitHub](https://github.com/NVlabs/diffstack)
- [DiffStack paper (CoRL 2022)](https://ml4ad.github.io/files/papers2022/DiffStack:%20A%20Differentiable%20and%20Modular%20Control%20Stack%20for%20Autonomous%20Vehicles.pdf)
- [TechCrunch: LocalStack raises $25M](https://techcrunch.com/2024/11/12/localstack-raises-25m-to-help-developers-emulate-and-test-cloud-apps-locally/)
- [Intellyx: LocalStack analysis (Nov 2025)](https://intellyx.com/2025/11/13/localstack-when-a-local-dev-cloud-is-better-than-the-real-cloud/)
- [LocalStack docs: Get started](https://docs.localstack.cloud/get-started/)
- [StackShare "my stack" page](https://stackshare.io/mytopsearch/my-stack)
- [Myappstack on G2](https://g2.com/sellers/myappstack)
- [TauStellwerk on GitHub](https://github.com/nic547/TauStellwerk)
- [STELLWERK Consulting AG on LinkedIn](https://de.linkedin.com/company/stellwerk-consulting-ag)
- [Stellwerk easy (Stellwerk Software)](http://www.stellwerk-software.de/)
- [Numeronym (Wikipedia)](https://en.wikipedia.org/wiki/Numeronym)
- [Kubernetes docs: kubectl](https://kubernetes.io/docs/reference/kubectl/)
- [K3s docs: command line tools](https://docs.k3s.io/cli)
- [K9s terminal UI for Kubernetes](https://palark.com/blog/k9s-the-powerful-terminal-ui-for-kubernetes/)
- [Siemens forum: S7T software](https://support.industry.siemens.com/tf/WW/en/posts/47682/)
- [Switchyard Python networking framework (PyPI)](https://pypi.org/project/switchyard/2017.1.5)
- [Switchyard Rust AI gateway (GitHub releases)](https://github.com/krutftw/switchyard/releases)
- [Red Hat JBoss SwitchYard docs](https://docs.redhat.com/en/documentation/Red_Hat_JBoss_Fuse/6.2.1/html/installation_on_apache_karaf/switchyard)
- [SignalBox.sh app listing](https://mwm.ai/apps/signalboxsh/6760046994)
- [RoundhousE on NuGet](https://packages.nuget.org/packages/roundhouse.core)
- [Bleach London Plex Bleach Box Kit (FeaturePlex Bleach)](https://mcgrocer.com/products/bleach-london-plex-bleach-box-kit)
- [Infor F9 financial reporting](https://www.infor.com/products/f9)
