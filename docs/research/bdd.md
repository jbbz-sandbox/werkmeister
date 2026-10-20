# BDD for Werkmeister: research and recommendation

[SW-64](https://jory-group.atlassian.net/browse/SW-64), October 2026. This is a research spike: it recommends, and one scenario proves the path. Nothing here is adopted yet.

## Decision

| Angle | Go / no-go | Runner | Layout |
|---|---|---|---|
| 1. Testing Werkmeister itself | **Go, narrow.** Gherkin for CLI behaviours against the built binary and for the PR gate and lifecycle rules. Everything else stays a plain unit test. | **QuickPickle** inside the CLI's existing Vitest | `apps/cli/features/<area>/*.feature`, `apps/cli/features/steps/`, `apps/cli/features/support/`, run as a second Vitest config or project |
| 2. The workspace pipeline, for any repo | **Go as an opt-in pilot; no-go as a default.** A repo opts in through `services.yaml`; repos that don't keep today's hand-written PASS tables. | **The repo's native Cucumber-family runner:** Cucumber.js, QuickPickle in Vitest repos, behave, godog, Cucumber-JVM | `<service path>/features/**/*.feature`, organised by capability and tagged with the ticket key (`@SW-64`), never one file per ticket |

The spike shows angle 1 works with no gate change. `apps/cli/bdd/pr_gate.feature` holds two scenarios against the built `werkmeister pr gate`: a docs-only change passes, and a code change with no way to run its tests is held. They run in the CLI's `npm test`, which is the command the gate already runs for the `cli` service.

## Runner comparison

Registry data from `npm view` and `api.npmjs.org`, 2026-10-20.

| | Cucumber.js | @amiceli/vitest-cucumber | QuickPickle | jest-cucumber | playwright-bdd |
|---|---|---|---|---|---|
| Latest | 13.3.0 | 8.0.0 | 1.11.2 | 4.5.0 | 9.2.1 |
| Last release | 2026-10-05 | 2026-09-05 | 2026-05-06 | **2024-07-25** | 2026-09-06 |
| First release | 2020 (as `@cucumber/cucumber`) | 2023 | 2024 | 2018 | 2023 |
| Weekly downloads | 1.09 M | 44 k | 5.5 k | 43 k | 440 k |
| Licence | MIT | ISC | MIT | Apache-2.0 | MIT |
| Maintainers | Cucumber org | one maintainer | one maintainer | one maintainer | one maintainer |
| ESM / TypeScript | ESM native; TS through a loader such as tsx or Node type stripping | ESM-only, TS native | ESM, TS native (Vite transform) | CJS with types | CJS with types |
| How scenarios run | Its own runner and process | Inside Vitest. Each `.feature` needs a matching `.spec.ts` that restates every scenario (`describeFeature`/`Scenario`) | Inside Vitest. A Vite plugin turns each `.feature` into a test file; global Cucumber-style steps | Inside Jest or Vitest, with the same mirrored-spec style as vitest-cucumber | Generates Playwright test files from features (`bddgen`), then runs them under `@playwright/test` |
| Step style | Global steps, Cucumber expressions, World | Closures per scenario; shared steps are an add-on | Global steps, Cucumber expressions, World; compatible with Cucumber.js step code | Closures per scenario | Global steps, Playwright fixtures |
| Reports | html, json, junit, messages built in | Vitest reporters | Vitest reporters (json, junit); no Cucumber messages | Jest/Vitest reporters | Playwright HTML, plus a Cucumber-style report |
| Fit with this repo | A fourth runner beside `node --test`, Vitest and test-electron. Best for angle 2 in TS repos that don't use Vitest | v8 needs Vitest 5, but the CLI is on **Vitest 3.2.7**: stuck on the old v5 line or a Vitest upgrade first | **Runs under Vitest 3.2.7 as installed** (peer `vitest >=1`). Proven by the spike | Stale for over a year: **no** | Needs Playwright, which the repo doesn't use. Only for the dashboard, and only if Playwright arrives |

Why QuickPickle for angle 1, despite having the fewest downloads:

- It is the only Vitest option that runs on the repo's Vitest as it stands.
- Its `.feature` files are the tests. There is no mirrored spec file to drift.
- Its step code is Cucumber.js-shaped: `Given("…{string}", (world, s) => …)`. If QuickPickle stalls (one maintainer, last release five months ago), the features and most step code move to Cucumber.js unchanged. That portability is the mitigation for the bus-factor risk.

Fallback: @amiceli/vitest-cucumber after a Vitest 5 upgrade, at the cost of a spec file per feature.

Not chosen: Serenity/JS (3.49.0, Apache-2.0) sits on top of Cucumber.js or Playwright to give the Screenplay pattern and rich living documentation. It is a large dependency for a suite that has two scenarios today. Revisit it when feature-coverage reporting is wanted (see Reporting).

## Which layers gain from Gherkin

Gherkin pays off where a scenario states a rule a person approves. It does not pay off where a test pins an implementation detail.

| Layer | Use | Why |
|---|---|---|
| CLI commands against the built binary | **Gherkin** for behaviours an acceptance criterion names: exit code, the message shown, the files written | These are the user-visible contract. The `cli` service's own `validate:` text already says "run the built binary against a temp fixture workspace". |
| PR gate and lifecycle (open, status, close-out) with a mocked tracker and GitHub | **Gherkin** for the rules: which checks block, docs-only paths, `skip_tests`, state → issue status | These rules are what the person approves, and today they live only in code and the `pr-lifecycle.test.mjs` stubs. GitHub can be faked at the binary level now (`SANDBOX_GH_BIN`). Docker can't (see below). Jira is reached through `fetch` and can only be stubbed in-process, so binary-level lifecycle scenarios should use the GitHub tracker with a fake `gh`. |
| Core library functions (`mapTouched`, parsers, registry merge) | **Plain unit tests** (`node --test`) | Input → output with no reader but an engineer. Gherkin adds a translation layer and nothing else. |
| MCP tools | **Plain tests** (in-memory MCP client, `apps/mcp/tools.test.mjs`) | A thin adapter over core. If a tool's behaviour is itself a criterion, reuse the CLI scenario's step library with an MCP task implementation, rather than writing a second feature. |
| Pane and dashboard UI | **Plain smoke tests now.** playwright-bdd for key journeys only if Playwright is adopted | The book's rule: a web test is only worth having for key journeys, what's presented, how it renders, and screen-specific logic. None of these is a current pain. |
| VS Code extension | **Plain** (`@vscode/test-electron`) | No BDD runner integrates with the Extension Development Host. Its checklist (`MANUAL-CHECKLIST.md`) covers the visual items. |

## Docker-backed steps in the gate

How the gate runs tests today (`packages/sandbox-core/src/pr_lifecycle.ts`, `gateChecks`):

- It maps the diff to services (`mapTouched`). A path in `no_service_paths` touches nothing; any other unmapped path touches every service in the repo.
- For each touched service it runs the service's `test:` command with `docker exec <container> sh -c <cmd>`, in any running container of that repo. Every container of a repo mounts the same worktree at `/app`.
- If no container of that repo is running, it starts one, idle types first, and stops it again afterwards (SW-34).

Rules for scenarios:

1. **A scenario about gate or CLI logic needs no daemon.** The spike's fixture workspace has no running container and no compose file, so the gate never starts one, and the scenarios check the gate's decisions from its output. This is the common case.
2. **A scenario that needs a live service runs inside that service's test command**, so it lands in the container the gate already uses. It costs what the service's tests cost now; it does not add a container. Tag these `@service` so they can be filtered out of a quick local run.
3. **A scenario must never start containers of its own** from inside the gate's container. The container has the host Docker socket, so a nested `compose up` would create real host containers.
4. **The spike's measured cost:** two scenarios take 1.9 s, and the second Vitest invocation about 3.3 s wall in all. That runs on top of a CLI suite of 505 tests.

One gap the spike hit: a scenario can't stand in for a *running* container. The gate looks up `docker` through `childEnv()`, which puts `/opt/homebrew/bin` and `/usr/local/bin` ahead of `PATH`, so a stub `docker` on `PATH` is never reached. GitHub already has a seam for this (`SANDBOX_GH_BIN`); Docker needs the same (follow-up 2).

## Pipeline fit (angle 2)

Today every autonomous run proves acceptance by hand:

- The brief carries a `- [ ]` criteria list.
- `03` writes an `exercise.md` PASS/FAIL table.
- `04 propose` writes a PASS table in `pr-<repo>.md`.
- The gate's `exercise` and `acceptance` checks are a regex: at least one `| PASS |` and no `| FAIL |`.
- Nothing ties a row to a criterion.

Executable scenarios make that link real. The proposed flow, for repos that opt in:

| Step | Who | What |
|---|---|---|
| Source | the issue | Acceptance criteria stay where they are. Gherkin is not written in the tracker: a person shouldn't have to write Given/When/Then to file a ticket. |
| Example Mapping, in stage 01 (research / reproduce) | agent | One section in the stage output. Each criterion becomes a rule, each rule gets concrete examples and counterexamples, and the questions go on a list. A question nobody can answer from the code is a "question only a person can answer", which is already a stop point. |
| Formulate, in stage 02 (spec), or 01 for bugfix | agent writes, person approves | `.feature` files in the code worktree, one `Rule:` per criterion, tagged with the ticket key. `spec.md` lists them instead of restating them. In autonomous runs the person approves them in the PR diff, so they belong at the top of the PR body. |
| Automate and exercise, in stage 03 | agent | Scenarios go red first, then green. `exercise.md`'s table is generated from the runner's report, one row per scenario, instead of being typed. A pending or undefined step is a FAIL. |
| Propose, in stage 04 | agent | The acceptance table maps each brief criterion to its scenario name. A criterion with no scenario is a defect, as `spec` already says for tests. |
| Gate | Werkmeister | Running scenarios needs **no new step**: they are part of the service's test command, which the gate already runs for touched services (proven by the spike). What it gains later is a `scenarios` check: read the report, require every scenario passed and none pending, and require every criterion to map to a tagged scenario. That check replaces the PASS regex for opted-in services. |

Should the gate run only the feature files a PR touches? **No.** The gate already narrows to touched services, and a service's scenarios are cheap next to its unit tests. A changed rule can also break a scenario whose file the PR never touched, and that is exactly the regression to catch.

An approved scenario is frozen. The agent may add scenarios, but changing an approved `Then` (or deleting a scenario) needs the person. The `scenarios` check can enforce this by diffing the `.feature` files against the commit the spec was approved at.

## A repo-agnostic contract

The gate only ever runs a command and reads a file, so the contract is two optional keys on a service (or its archetype) in `services.yaml`:

```yaml
services:
  api:
    repo: payments
    path: services/api
    test: make test          # unchanged: must also run the features
    acceptance:
      features: features     # relative to the service path; where stage 02 writes .feature files
      report: build/cucumber.json   # Cucumber JSON, written by the test command
```

Every runner can meet it with one command line:

| Runner | Runs a directory | Writes Cucumber JSON |
|---|---|---|
| Cucumber.js | `npx cucumber-js features` | `--format json:build/cucumber.json` |
| QuickPickle / Vitest | a Vitest `include` of `features/**/*.feature` | Vitest `--reporter=json` (a converter is needed for Cucumber JSON, or the check reads Vitest JSON) |
| behave (Python) | `behave features` | `-f json -o build/cucumber.json` |
| godog (Go) | `godog run features` or `go test` with a `godog.TestSuite` | `--format cucumber:build/cucumber.json` |
| Cucumber-JVM | JUnit Platform suite over `features` | `cucumber.plugin=json:build/cucumber.json` |

Cucumber JSON is the common format: all five emit it, and its scenario names and tags are what the `scenarios` check and the generated exercise table need. Repos with no `acceptance:` key change nothing.

## Keeping agent-written steps from going brittle

This uses *BDD in Action* (Smart and Molak, 2nd ed.): ch6 for Example Mapping, ch7 for the six marks of a good scenario, ch9 for layers of abstraction, ch12 and ch15 for Screenplay. These rules belong in the stage templates:

1. **Example Mapping before Gherkin.** Rules, then examples, then counterexamples, then questions. The spike's second scenario is the counterexample to the first: a docs-only change passes, a code change is held.
2. **Declarative steps in the domain's words.** Write "an approved workspace whose branch changes only `docs/guide.md`", not "write `status: approved` to `stages/02_propose/output/pr-app.md`". Test each step: would it survive a renamed flag, file or screen?
3. **One rule per scenario**, under a `Rule:` keyword. Leave the outcome out of the scenario title.
4. **Three layers.** The `.feature` file holds the business rules. Step definitions are a thin business flow that calls tasks. Tasks and fixtures are the technical layer: spawn, fs, git. The spike folds the last two into one `steps.ts` because it has three steps. Adoption should split out `support/` with tasks named for goals (`approvedWorkspace({ changes })`, `runGate(ws)`), which is a light Screenplay. Then the same task can have a CLI implementation and an MCP one.
5. **Reuse before adding.** Before writing a step, the agent searches the existing step expressions. Runs are strict, so an undefined or ambiguous step fails rather than passing as pending.
6. **Every new scenario must fail when its rule is broken.** The agent shows this once by breaking the rule. In the spike, removing `docs` from `no_service_paths` turns the docs-only scenario red.

How Claude did at this in the spike:

- The steps were written in one pass, and the run caught both mistakes it made: an escaped `\b` mangled into a control character (caught by biome), and a stub `docker` that could never be reached (caught by the failing scenario).
- The failure mode to guard against is the second one. The obvious fix was to reach into infrastructure to force the outcome. The better fix was a different observable in the domain's terms: the gate holds the change and names the service.
- The rules above, plus the mutation check, are what steer an agent there.

## Reporting and living documentation

| Home | Verdict | What goes there |
|---|---|---|
| The PR | **Yes** | The feature files themselves, which are in the diff, and the generated acceptance table (criterion → scenario → result). This is where the person reads and approves the spec. |
| The workspace record | **Yes** | `exercise.md` generated from the report, committed with the stage output. That keeps the record diffable run to run. |
| The dashboard | **Not now** | It would need a store and a renderer for something a person reads once per PR. Revisit when features accumulate and *feature coverage* (criteria with no scenario yet) is worth a view. That is also when Serenity/JS earns its weight. |
| CI | Optional | Cucumber HTML as a build artifact, for repos whose runner emits it. |

## The spike

What it is:

- `apps/cli/bdd/`, a single folder: `pr_gate.feature`, `steps.ts`, `vitest.config.ts`.
- QuickPickle as a dev dependency.
- `&& vitest run -c bdd/vitest.config.ts` added to the CLI's `test` script.

To remove it, delete the folder, that half of the script and the dependency.

Each scenario builds a throwaway workspace in a temp dir: a record with stage output, a code repo whose `origin/main` sits one commit behind the branch, and a registry in a temp `HOME` through `WERKMEISTER_CONFIG_FILE`. It then runs `dist/main.js pr gate`. No real `~/.werkmeister`, tracker or GitHub is touched.

```
$ npx vitest run -c bdd/vitest.config.ts      # in apps/cli, after `node esbuild.mjs`
 ✓ pr_gate.feature (2 tests) 1915ms
   ✓ … Rule: a change to docs alone runs no service tests > Scenario: an approved docs-only change passes the gate  1063ms
   ✓ … Rule: a change to a service's files needs that service's tests > Scenario: a code change with no way to run its tests is held  849ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

The gate run of the same scenario is recorded in the SW-64 workspace's stage output and PR body.

## Follow-ups

These are listed for filing in SW and linking to SW-64. They are not filed.

1. **Runner setup.** Move `apps/cli/bdd/` to `apps/cli/features/` with a `support/` task layer, run it as a Vitest project in the existing config, and add the first lifecycle scenarios (open, status, close-out) with a fake `gh`.
2. **Docker seam for scenarios.** Add `WERKMEISTER_DOCKER_BIN`, like `SANDBOX_GH_BIN`, so a scenario can stand in for a running container and assert which tests the gate ran.
3. **`services.yaml` acceptance contract.** Add `acceptance: { features, report }` to services and archetypes: the fragment schema, the core types, and the sandbox-context.md "How to validate" table.
4. **Stage template changes.** Example Mapping in 01, `.feature` files in 02 spec (or 01 for bugfix), `exercise.md` generated from the report in 03, and criterion → scenario mapping in 04. All of these apply only when the service declares `acceptance`.
5. **Gate `scenarios` check.** Read the report: every scenario passed, none pending or undefined, every brief criterion mapped to a tagged scenario, and no approved scenario changed. For opted-in services it replaces the PASS regex.
