# Naming Research — Renaming the sandbox Tool for Open Source

> Exploration notes, not a decision. No name has been chosen.
> Research done 2026-10-12. Registry and web results are as of that date; names get
> claimed, so re-check anything here before relying on it.

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
| **Nebengleis** | NAY-ben-glice | A side track next to the main line | free | free | Nothing found. Numeronym n8s free, but looks like k8s |
| **Weiche** | VY-kheh | A track switch | free | **taken** | PyPI name belongs to a Deutsche Bahn train-connection lookup tool |
| **Baustelle** | BOW-shtel-leh | Construction site | free | free | Nothing found. Numeronym b7e free |
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
- Numeronym s7k not checked further.

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
| Abzweig, Nebengleis, Baustelle, Spurwerk | a5g, n8s, b7e, s6k | Open, not pursued | Free; harder to say, or numeronym looks like others |
| Featurelane, Graftstack | — | Open, not pursued | Free on npm; weaker meaning |
| Junction | j6n | Open, not searched | |
| Stellwerk | s7k | **Ruled out** | Reserved on crates.io by an AI-agent project; GitHub name probably taken |
| LocalStack | — | **Ruled out** | Funded company in the same field |
| Mystack | — | **Ruled out** | Everyday phrase; npm name taken; says nothing about the tool |
| Switchyard, Signalbox, Roundhouse | — | **Ruled out** | Existing developer software with the same name |
| Weiche | — | Weakened | PyPI name taken |

## 9. Size of the rename

When a name is chosen, the rename itself is a separate piece of work. At the time of this
research, "sandbox" appears 6,792 times in 374 of the repo's 441 tracked files, including:

- the `sandbox` command and the npm package `@jbbz-sandbox/sandbox-cli`
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
