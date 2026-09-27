---
name: sb-test
description: "Begin the test phase in a sandbox workspace. Use when running or writing tests — after an implementation lands, before review or a PR, or when the user asks to verify a change with the test suite."
---

# sb-test — enter the test phase

- **Step 0 — scope the run.** From the change at hand (the diff, or the task if nothing
  is edited yet), identify which services are affected, then read the workspace
  `CLAUDE.md` "Standards routing" block to see which archetypes those services belong
  to. When in doubt, the Services table in `.sandbox/sandbox-context.md` maps services
  to repos and paths.
- Do **not** load the code standards yourself — the tester agents carry the pointer to
  the standard that governs test code; this phase's main-agent job is dispatch and
  interpretation.
- **Spawn the matching `sb-tester-<archetype>` agent(s)** (generated into
  `.claude/agents/`) — one per archetype whose services the change touches; spawn them
  in parallel when there is more than one. Each agent carries its services' exact test
  commands, may edit **test files only**, and returns per-service pass/fail, failing
  assertions with suspected causes, and open questions.
- **Verifying the running feature.** The tester agents run a proxy smoke check (curl
  through Caddy with the `X-Feature` cookie) when the containers are up. For a headed
  browser session against the feature URL, use the `sandbox-tools:sandbox-feature-test`
  plugin skill; the URL and cookie are in `.sandbox/sandbox-context.md`.
- **Fallback** (a workspace generated before tester agents existed, or a service with
  no tester): run the tests inline under the same rules — the test command is the
  service's `test:` in `~/.sandbox/services.yaml` (or its archetype's) or the repo's
  `package.json`; edit only
  test files; never "fix" application source in this phase.
- Relay the results per service, then put the testers' OPEN QUESTIONS / AMBIGUITIES to
  the user (AskUserQuestion) and let them resolve those **before** proposing fixes.
- Fixing a failure is the implement phase: invoke `sb-implement` first (it loads the
  universal base and the matching domain standards), and capture an abandoned approach
  or a settled decision as a `.sandbox/notes/` note at the moment it happens.
