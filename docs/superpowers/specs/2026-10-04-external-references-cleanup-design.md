# External References Cleanup — Design

Source: `external-references-review.md` (2026-10-03). Every finding in tiers A–D and the
side findings is in scope. Tier E stays as is.

## Goal

The tool ships nothing from the original deployment: no org ids, hostnames, channels,
emails, private codebase names, or personal paths. Stack-specific integrations (Jira,
Slack, Apollo Federation) stay in core. Each one is optional and driven by config, and
the docs present them that way.

## Decisions

| Area | Decision |
|------|----------|
| Tier C integrations | Keep in core, make optional and config-driven, and reword the docs. Nothing is extracted or removed. |
| Experiments (C3, B7) and org taxonomy (C1, C2) | Delete `docs/experiments/context-management/`. Rewrite the C1/C2 tables with generic examples. |
| `docs/superpowers` (D2–D5) | Scrub personal paths and repo names in plans and specs. Delete `docs/superpowers/archive/`. |

## Changes

### 1. Hardcoded values in shipping code (A1–A5, plus the Slack channel)

The review's line numbers have drifted. A2 and A3 are already fixed: `jiraBrowseUrl()`
in `sandbox-core/issue_tracker.ts` builds links from `jira.base_url`. What's left:

- **A1: Jira cloud id in Claude prompts** (`sandbox.ts`, `JIRA_CLOUD_ID` and its 4 uses).
  Delete the constant. Add `jiraSiteRef(): string | null` to `issue_tracker.ts`. It returns
  `jira.cloud_id` when that is set, otherwise the hostname of `jira.base_url` (the Atlassian
  MCP tools accept a site URL as `cloudId`), otherwise null. Prompts use
  `(Atlassian cloud id ${ref})` when there is a ref. With no ref, they say
  `(find the cloud id with getAccessibleAtlassianResources)`. A single helper builds that
  phrase, so all 4 prompts change the same way.
- **A4: dashboard PR row** (`apps/sandbox-dashboard/src/prs-ui.ts`). The browser can't
  read config. The server already maps PRs (`server.ts`, `jiraKey`). Add
  `jiraUrl: string | null`, computed with `jiraBrowseUrl()`, to the PR payload and its zod
  schema. The UI links only when `jiraUrl` is set and otherwise shows the key as plain
  text, the same way the workspace badge already behaves.
- **A5: setup snippet** (`machine_setup.ts`, `JIRA_CONFIG_SNIPPET`). Use
  `https://your-org.atlassian.net`, the placeholder `sandbox setup` already uses. Add it to
  `JIRA_PLACEHOLDERS` so an unedited snippet fails validation.
- **New: Slack channel** (`sandbox.ts`, `DEFAULT_REVIEW_SLACK_CHANNEL = "C0963TE8J91"`).
  Delete the default. When `SANDBOX_REVIEW_SLACK_CHANNEL` is unset, throw the same kind of
  clear `WorkspaceError` the missing token throws. Update any doc that mentions a default
  channel.

### 2. Identifiers in docs and fixtures (B1–B7)

- B1, B2 `docs/jira-rest-setup.md`: replace with `your-org.atlassian.net`, and replace the
  two-email anecdote with a generic note ("use your Atlassian login email").
- B3 `jira_config.test.ts`: `https://example.atlassian.net/` and `dev@example.com`. The
  assertions update to match.
- B4 `troubleshooting-advanced.md`: delete the "Auth0 errors" entry under `demo-services`.
  It is wrong, since demo-services has no Auth0. Nothing replaces it.
- B5 `setup_steps.test.ts`: rename the fixture to `web` with `SESSION_SECRET` and
  `OAUTH_CLIENT_SECRET`. The test still needs two secret keys, and only the names change.
- B6 `build-tree.test.mjs`: `TRE-1125` → `PROJ-1125`.
- B7: handled by the experiments deletion in section 3.

### 3. Stack conventions presented as the tool's (C1–C8)

- **C3 + B7**: `git rm -r docs/experiments/context-management/`. Fix every inbound
  reference: `docs/context-management-research.md` (L227-228),
  `docs/jit-context-system.md` (L34, L480), `docs/scamper-market-expansion.md` (L27),
  `packages/sandbox-core/skill_gen.ts` (L211 comment), and
  `docs/superpowers/specs/2026-09-27-context-strategy-interface.md`. Each keeps its finding
  as prose and drops the link. Example: "measured in internal experiments (not
  published)".
- **C1** `jit-context-system.md` L67-79: replace "all nine current domains" with a short
  *example* table using generic domains (e.g. `auth`, `data`, `api`, `ui`, `testing`) and
  stack-neutral descriptions. Say that domains come from the configured standards repo.
- **C2** `context-management-research.md` L392, L408: use generic archetypes such as
  `web-ui`, `api-service`, `data-pipeline`, `gateway`. Keep the analysis the same.
- **C4: Apollo Federation in `sandbox up`.** `generateSupergraphConfig` currently writes
  `.sandbox/supergraph-config.yml` and logs "Generated supergraph config" for every
  workspace, including those with zero GraphQL services. Change it to return `null`
  without writing or logging when no service has a `_GRAPHQL_TYPES` type, and delete a
  stale file if one exists. The return type becomes `string | null`, and the callers in
  `lifecycle.ts` (3 sites) and any others that grep turns up ignore the return or handle
  null.
- **C5, C8 docs** (`sandbox-architecture.md`, `users-guide.md`): move the federation
  material under an "Optional: GraphQL federation" heading that states it only activates
  when a service declares `type: graphql-subgraph`. Change the C8 example output to a
  generic `k8s: api (:9004), redis (:9050)`.
- **C6: Jira.** The tracker switch already exists (`overrides.issue_tracker`:
  jira|github). Remaining work:
  - `apps/cli/infra/skills/sb-pr/SKILL.md`: the title and `Refs:` use `<ISSUE-ID>`, which
    is a Jira key or `owner/repo#n`. The "transition to In Development" step applies only
    when the tracker is Jira.
  - Docs (users-guide and README, wherever Jira is presented as required): one sentence
    saying the tracker is Jira or GitHub, chosen in `sandbox setup`, and that Jira links
    need `jira.base_url`.
  - The dashboard and VS Code tree already behave correctly when `jiraUrl` is null (see
    A4). The create form, workspace UI and VS Code tree are not reworked further.
- **C7: Slack.** Section 1 removes the default channel. The docs describe review
  requests as an optional Slack integration that needs both env vars.

### 4. Personal environment leakage (D1–D5)

- D1 `known-issues.md`: `/Users/jayboyer/repos/sandbox/apps/cli` →
  `<sandbox-checkout>/apps/cli`.
- D2–D4 plans and specs: `/Users/jayboyer/repos/<x>` → `~/repos/<x>`. Any other
  `/Users/jayboyer` becomes `~`. `wellness` → `mobile-app` (a placeholder Expo repo), with
  matching names (`EXPO_PUBLIC_API_URL` stays as is because it's a generic Expo
  convention).
- D5: `git rm -r docs/superpowers/archive/`.

### 5. Side findings

- `git rm --cached` the 4 tracked `.pyc` files: the 3 in the review plus
  `bin/__pycache__/feature-browser.cpython-312.pyc`. Add `__pycache__/` and `*.pyc` to
  `.gitignore`.

## Out of scope

- Tier E items.
- Extracting integrations into plugins, generic webhooks, or tracker abstractions beyond
  the existing jira|github switch.
- Rewriting git history. Deleted files stay in history.
- The built `apps/cli/dist` (untracked). It picks up the changes on the next build.
- `external-references-review.md` stays untracked. Delete it once the work lands.

## Verification

1. The leak grep returns nothing across tracked files, excluding the vendored bundle and
   this spec and its plan, which name the strings on purpose:
   `git grep -nE 'hgdata|hginsights|4a4bd20b|C0963TE8J91|/Users/jayboyer|interview-service|wellness|TRE-1125' -- ':!*.bundle.js' ':!docs/superpowers/*/2026-10-04-external-references-cleanup*'`
2. `npm test`, `npm run typecheck`, `npm run build` all pass.
3. New and updated tests:
   - `jiraSiteRef()`: cloud_id wins, then base_url hostname, then null.
   - `generateSupergraphConfig` returns null and writes no file when there are no GraphQL
     services, and still writes one when there is a subgraph.
   - `postSlackReviewRequest` throws when the channel is unset (token set).
   - `JIRA_CONFIG_SNIPPET` left unedited fails Jira validation.
4. `git grep -n 'experiments/context-management'` returns nothing.
