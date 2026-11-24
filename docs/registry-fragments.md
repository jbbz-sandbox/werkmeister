# Registry fragments

The fields of a repo's registry fragment, `<repo>/.werkmeister/services.yaml`, and how its `test:` and `validate:` are used.

A repo can also ship its own ICM workflows in `<repo>/.werkmeister/workflows/`: see [Adding your own workflow](icm-workflows.md#adding-your-own-workflow).

## Writing a fragment

A fragment is a slice of the registry committed at `<repo>/.werkmeister/services.yaml`. `werkmeister machine detect` writes a first draft of this file for you; see [werkmeister machine detect](cli-reference.md#werkmeister-machine-detect).
For the whole process of adding a repo, with a checklist of common mistakes, see [Setting up a repo](repo-setup.md).
Its JSON Schema is `apps/cli/infra/schemas/services-fragment.schema.json`. `werkmeister machine setup`
offers to map it (and `workspace.schema.json`) in VS Code's user `yaml.schemas` by local
path, which turns on validation through the redhat.vscode-yaml extension. Don't add a
`# yaml-language-server` modeline or a `$schema:` key: the repo is private, so the GitHub
URL 404s, and either one outranks the local mapping (the merge also rejects `$schema:` as
an unexpected top-level key):

```yaml
services:
  my-api:
    path: services/my-api         # within the repo; `.` for the whole repo; a `..` segment fails the merge
    type: api                     # api | web | library | cli | extension
    archetype: node-service       # optional; node-web | node-service | node-tool | mcp-client
    test: "npm test"
    validate: "..."               # optional; how a person or agent checks a change by hand (overrides the archetype's). See "Test commands and validation guidance"
    stages:                       # optional; text the matching ICM stage contracts add (overrides the archetype's, per role). See "Stage text"
      research: "..."
    internal_port: 3000           # port the process listens on in-container
    port_offset: 9                # slot-relative host port; unique across ALL repos
    health_endpoint: /health      # or redis | postgres | "" (TCP-only); unset means /health everywhere
    image: node:22-alpine
    command: "cd services/my-api && exec npm start"
    memory_limit: 1G
    memory_reservation: 256M
    setup_service: my-install     # optional; a key in setup_services: below
    node_modules_volume: node-modules
    feature_router: {}            # optional; opts into Caddy ingress at <service>.<local_domain>
    secrets: [MY_API_KEY]         # optional; keys werkmeister up requires in ~/.werkmeister/secrets.env
setup_services:
  my-install:
    image: node:22-alpine
    command: "npm install"
    node_modules_volume: node-modules
infrastructure: {}                # cluster-forwarded datastores this repo needs (see demo-services)
```

Rules:
- Only `services:`, `setup_services:` and `infrastructure:` may appear. `repo:` is the
  checkout's directory name and `repos:` is derived from each service's `path`.
- <code v-pre>{{home}}</code>, <code v-pre>{{repos_root}}</code> and <code v-pre>{{workspaces_root}}</code> expand from the developer's
  `config.yaml`, <code v-pre>{{werkmeister_home}}</code> to the tool's home folder (`~/.werkmeister`, or
  `~/.sandbox` until `werkmeister machine migrate`), and <code v-pre>{{local_domain}}</code> to `ingress.local_domain`; <!-- name-check: ignore -->
  use them instead of absolute paths and hard-coded domains in
  `extra_volumes:` and `environment:`.
- A `secrets:` key resolves from the workspace's `.werkmeister/workspace.yml` `env_vars:` first,
  then `~/.werkmeister/secrets.env` as `<SERVICE>__KEY` (service name uppercased, `-` → `_`,
  e.g. `MY_API__MY_API_KEY`), then plain `KEY`. A value from `secrets.env` reaches only
  that service, as plain `KEY`, through the git-ignored `<workspace>/.env.<service>`; the
  shared workspace `.env` holds no secrets. An `env_vars:` value also sits in that shared
  `.env`, so every service sees it, and `env_vars:` keys are never namespaced. Namespaced
  keys no service declares (e.g. test logins for agents) reach no container.
- `unattended_start: <reason>`: an autonomous run gets no pre-approved start or restart
  (`feature up`, `feature up --service`, `docker restart`) for a service whose `extra_volumes` give it the
  docker socket or the werkmeister home, since its `command:` often runs a script the agent can edit. This
  field records why one such service is safe to start anyway. Only the machine registry's value counts
  (synced from the default branch); a branch's own fragment cannot grant it.
- `x-` keys are dropped from the output and exist to hold YAML anchors.
- A duplicate service name, `port_offset` or `k8s_forward_port` across two repos fails the
  merge naming both. `werkmeister registry --check` reports drift.
- Helm charts (`charts/*.values.yaml`) give you `internal_port` (`containerPort`),
  `health_endpoint` (`probePath`) and `k8s_port` (`service.port`); the dev `image`,
  `command`, `port_offset` and the Werkmeister-side `environment` are yours to decide.

Per-machine values (`k8s_context`, a bigger `memory_limit` on your laptop) go in
`~/.werkmeister/services.local.yaml`, which merges last.

## Test commands and validation guidance

Each service can carry two related keys. They do different jobs, and a change needs both.

| | `test:` | `validate:` |
|---|---|---|
| What it is | A shell command, e.g. `pnpm turbo run test --filter=werkmeister-core` | Plain-language instructions, e.g. "Build, then run the built binary against a temp fixture workspace; assert on exit code, stdout/stderr and the files it writes." Never executed. |
| Who uses it | Tooling: the implement stage's test step, `werkmeister pr gate`, `werkmeister feature test`'s fallback message | Whoever exercises the change: an agent in the implement stage, or you |
| Question it answers | Do the automated tests still pass? | Does the change actually do what was asked, seen from outside? |
| Evidence it leaves | The exit code and summary line | A `\| check \| result \|` table of PASS/FAIL rows with the captured output (`exercise.md`) |

**How each is resolved.** A service's own value wins over its archetype's. A `test:` template from an archetype has `{service}` replaced by the service name. When neither is set:

| Missing | What shows up |
|---|---|
| `test:` | The How to validate table shows `—`. The gate fails `test <service>` unless the PR file sets `skip_tests: { <service>: <reason> }`, which is accepted for a service with no test command or a container the gate could not start. A service that has no tests at all sets `test: none` (or `test: "none: <reason>"`) instead: it beats the archetype's template, the gate reports `test <service>` skipped with that reason, and `werkmeister-context.md` shows `no tests (registry: <reason>)`. A service whose tests another service's `test:` already runs keeps its own `test:` and adds `test_covered_by: <that service>`: when both are rows in one gate, its container is not started and its row reads `covered by <that service>` (docs/workspace-lifecycle.md). |
| `validate:`, service has a `feature_router:` | "URL health check (see Quick Health Checks)": the proxy, cookie and health-check sections of `werkmeister-context.md` are the validation. |
| `validate:`, no `feature_router:` | "No validation guidance registered in services.yaml; say so instead of inventing one". Add a `validate:` value rather than leave agents to guess. |

The shipped archetypes give `node-tool` (libraries) and `mcp-client` (editor extensions) a default `validate:`. A CLI service sets its own, because "run the unit tests" doesn't show that a command does the right thing.

**Where each is used, in order:**

1. **`.werkmeister/werkmeister-context.md`.** The first section, "How to validate", has one row per workspace service: repo, path, test command, validation. Both keys are read from here, not from the registry directly. The test command is prefixed with the workspace's `.werkmeister/bin/with-temp-home`, which `init-workspace` writes: it runs the command with a fresh temporary `HOME` and deletes it on exit, so no test reaches the real `~/.werkmeister`.
2. **Implement stage (ICM)**, or the test phase in JIT (`w9r-test` and the tester agents):
   - The **test step** runs each touched service's test command exactly as `werkmeister-context.md` states it.
   - The **exercise step** reloads the running code, then checks the change the way the service's validation text says. It records the result in `output/exercise.md` as a `| check | result |` table.
   - `test:` catches regressions; `validate:` shows the new behaviour works. Passing tests are not a substitute for the exercise.
   - The **review step** (ICM feature and refactor implement, bugfix/incident exercise) has a fresh subagent run `ponytail:ponytail-review` over the uncommitted diff. It fixes every Must fix and writes `output/review.md`, which the PR gate checks like `exercise.md`.
3. **PR gate** (`werkmeister pr gate`, re-run by `werkmeister pr open`):
   - It re-runs `test:` for every service the branch touches, inside a running container of that repo. When none runs, it starts one and stops it afterwards, so a workspace with no services listed still passes. compose.yml carries the repo's other services behind the `on-demand` profile for this.
   - It doesn't read `validate:` itself. It checks the exercise evidence: the exercise table must have at least one PASS row and no FAIL row. An ICM workspace keeps it in `stages/*/output/exercise.md` (`verify.md` in workspaces made before the rename); JIT keeps it in `.werkmeister/notes/exercise.md`.
4. **`werkmeister feature test`** runs the Playwright suite if the workspace or one of its repos has one. With no suite, it runs nothing and prints each service's test command and validation text instead, since libraries, CLIs and extensions are checked that way.

**Writing a good `validate:` value:**
- Say what to run and what to observe: a command and the output, files or UI state that proves the change, not "verify it works".
- Don't repeat the test command; `test:` already covers that.
- Name any manual list a person has to walk, e.g. `MANUAL-CHECKLIST.md` for the VS Code extension.
- Keep it to a sentence or two. It shows in a table cell and in tester-agent prompts.

## Stage text

`validate:` tells the exercise how to check a service. `stages:` goes further: it adds a short instruction to the ICM stage contracts of every workspace that covers the service, at the stage that does that kind of work. It suits steps an app needs that the generic stages can't know, such as running schema composition before the tests.

```yaml
services:
  products:
    stages:
      research: "List the entities and @key fields this subgraph owns or extends."
      implement: "Run supergraph composition (rover supergraph compose) and fix its errors before the tests."
```

Keys are roles, the same in every work type:

| Role | Stage it goes into |
|---|---|
| `research` | feature `research`, bugfix `reproduce`, refactor `scope` |
| `spec` | feature `spec` |
| `implement` | feature and refactor `implement`, bugfix `fix` |
| `exercise` | bugfix `exercise`; feature and refactor `implement`, after the implement text |

A role the work type has no stage for (`spec` in a bugfix) is left out, and spike stages take none. A stage in your own workflow takes text when its `workflow.yaml` entry sets `role:` ([ICM workflows](icm-workflows.md#workflowyaml)).

**How it is resolved.** Per role, a service's own text wins over its archetype's. Only the workspace's services count: the ones it selects, else every service of its repos. Init renders the text in a `## For this workspace's services` section of the stage contract, under a `### <service>` heading (with the archetype's name when the text came from it). Services with the same text from the same source share one heading. A workspace with no stage text gets no section. JIT workspaces ignore `stages:`.

**Limits.** Each value is plain text of at most 600 characters. Init fails with an `[err]` line, before it writes `.env` or any stage contract, on a longer value, an unknown role, a value that isn't text, or a line that starts with `# ` or `## ` (it would open a contract section of its own). Put longer guidance in a doc in the repo and link to it from the text.
