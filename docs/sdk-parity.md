# SDK parity: MCP tools and CLI commands

Every MCP tool and every CLI command, and the [`werkmeister-core/sdk`](../apps/docs-site/sdk-index.md) export that does the same job (SW-748). A row either names the exports or says why it has none. `pnpm run docs:check` fails when a tool or command has no row, or when a row names an export the SDK doesn't have.

werkmeister's own apps (the MCP server and the CLI) import internal entries, not the SDK. This table maps what they *offer*, not how they're built. Any tool is also reachable through `callTool`, with the arguments the [SDK reference](../apps/docs-site/sdk-index.md) lists.

## MCP tools

| Tool | SDK export | Note |
| --- | --- | --- |
| `up` | `runWorkspaceAction` | action `"up"` |
| `down` | `runWorkspaceAction` | action `"down"`; `removeVolumes` only through `callTool("down")` |
| `stop` | `runWorkspaceAction` | action `"stop"` |
| `pause` | `runWorkspaceAction` | action `"pause"` |
| `resume` | `runWorkspaceAction` | action `"resume"` |
| `restart` | `runWorkspaceAction` | action `"restart"` |
| `detect` | `planFragment`, `planSummary`, `collectQuestions`, `applyAnswers`, `renderFragment`, `validateFragment`, `writeFragment` | |
| `services` | `featureServices` | |
| `logs` | `streamLogs` | |
| `remove-service` | `removeService` | |
| `test` | `runFeatureTests` | |
| `proxy-reload` | `reloadProxy` | |
| `close-out` | `closeOut` | |
| `init-workspace` | `initWorkspace` | |
| `skills` | `strategyFor` | its `check` / `sync` |
| `standards` | `checkStandards` | |
| `hooks` | `strategyFor`, `harnessLayoutFor` | its `refresh` |
| `notes` | `listNotes`, `parseNote`, `graduateNote` | |
| `connect` | `infraUp`, `infraHealth`, `connectK8s` | |
| `open-feature` | `openFeatureBrowser` | |
| `intercept` | `startIntercept`, `leaveIntercept` | |
| `create-workspace-form` | `getFormSchema`, `fetchIssueFormData` | |
| `create-workspace` | `createWorkspace` | |
| `workspace-form-schema` | `getFormSchema`, `fetchIssueFormData` | |
| `issue-form-data` | `fetchIssueFormData` | |
| `refine-prompt` | `refinePrompt`, `buildRefinePrompt` | |
| `list-workspaces` | `listWorkspaces` | |
| `open-workspaces-ui` | | excluded: opens the dashboard in a browser for a person; a UI builds on `listWorkspaces` and `getWorkspaceStatuses` |
| `open-workspace` | `openWorkspace` | |
| `workspace-prs` | `getWorkspacePRs` | |
| `issue-statuses` | `getIssueStatuses` | |
| `open-prs` | `getOpenPrs` | |
| `pr-approve` | `approvePr` | |
| `ask-pr-review` | `postSlackReviewRequest` | |
| `issue` | `fetchIssueCard` | |
| `pr-reconcile` | `launchPrReconcile` | |
| `workspace-pr` | `gatePrs`, `openPrs`, `refreshPrStatus` | |
| `status` | `getWorkspaceStatuses`, `statusSnapshot`, `interceptsSnapshot` | |
| `check-in` | `checkInTriage` | |
| `workspace-usage` | `getWorkspaceUsage` | |
| `docker-ui` | `getDockerUi` | |
| `k8s-forwards-status` | `getK8sForwardsHealth` | |
| `kube-context` | `getKubeContext` | |
| `kube-switch` | `switchKubeContext` | |
| `clean` | `planClean`, `runClean` | |
| `stats` | `runCollection`, `containerStats` | |
| `optimize` | `optimizeReport` | |
| `metrics` | `metricsReport` | |
| `cache` | `pruneCaches` | |
| `registry` | `syncRegistry` | |
| `resources` | `getWorkspaceResources` | |
| `budget` | `waitingQueue` | the slot and budget figures are scheduler internals |
| `intercepts` | `interceptsSnapshot` | |
| `scheduler` | `schedulerOp`, `waitingQueue` | |
| `claude-transcript` | `getClaudeTranscript`, `listSessions` | |
| `relay-check` | `getClaudeTranscript`, `relayPickedUp` | |
| `claude-send` | `sendToClaudeSession` | |
| `claude-turn-status` | `getClaudeTurnStatus` | |
| `claude-resume` | `resumeClaudeInTerminal` | |

## CLI commands

| Command | SDK export | Note |
| --- | --- | --- |
| `feature up` | `runWorkspaceAction` | action `"up"` |
| `feature down` | `runWorkspaceAction` | action `"down"` |
| `feature restart` | `runWorkspaceAction` | action `"restart"` |
| `feature pause` | `runWorkspaceAction` | action `"pause"` |
| `feature resume` | `runWorkspaceAction` | action `"resume"` |
| `feature stop` | `runWorkspaceAction` | action `"stop"` |
| `feature services` | `featureServices` | |
| `feature logs` | `streamLogs` | |
| `feature drop` | `removeService` | |
| `feature test` | `runFeatureTests` | |
| `feature open` | `openFeatureBrowser` | |
| `feature status` | `statusSnapshot`, `getWorkspaceStatuses` | |
| `workspace prompt` | `startArgs` | its `prompt` |
| `workspace new` | `createWorkspace` | |
| `workspace list` | `listWorkspaces` | |
| `workspace code` | `openWorkspace` | |
| `workspace serve` | | excluded: a foreground python3 server for an agent's browser check (SW-963) |
| `workspace init` | `initWorkspace` | |
| `workspace close` | `closeOut` | |
| `workspace abandon` | `closeOut` | with `abandon: <reason>` |
| `pr` | | excluded: a group; its verbs are the rows below |
| `pr gate` | `gatePrs` | |
| `pr open` | `openPrs` | |
| `pr push` | `pushPrs` | |
| `pr status` | `refreshPrStatus` | |
| `pr adopt` | `adoptPr` | |
| `pr watch` | `watchPrs` | |
| `pr new` | `newPr` | |
| `issue` | | excluded: a group; its verbs are the rows below |
| `issue view` | `issueTracker` | its `getIssue` |
| `issue update` | `issueTracker` | its `updateIssue` |
| `issue create` | `issueTracker` | its `createIssue` |
| `issue start` | `startIssue` | |
| `issue ready` | `issueTracker` | its `listReady` |
| `infra intercept` | `startIntercept`, `leaveIntercept` | |
| `infra connect` | `infraUp`, `infraHealth`, `connectK8s` | |
| `infra proxy-reload` | `reloadProxy` | |
| `infra up` | `infraUp` | |
| `infra down` | `infraDown` | |
| `infra restart` | `infraRestart` | |
| `infra stop` | `infraStop` | |
| `infra status` | `getK8sForwardsHealth` | |
| `skills` | `strategyFor` | |
| `standards` | `checkStandards` | |
| `notes` | `listNotes`, `parseNote`, `graduateNote` | |
| `machine detect` | `planFragment`, `planSummary`, `collectQuestions`, `applyAnswers`, `renderFragment`, `validateFragment`, `writeFragment` | |
| `machine clean` | `planClean`, `runClean` | |
| `machine tokens` | `staleTokens`, `revokeWorkspaceToken` | |
| `machine stats` | `runCollection`, `containerStats` | |
| `machine optimize` | `optimizeReport` | |
| `machine setup` | | excluded: an interactive wizard that prompts a person at each step |
| `machine config` | | excluded: an interactive wizard that prompts a person at each step |
| `machine migrate` | `migrate` | |
| `cache` | `pruneCaches` | |
| `registry` | `syncRegistry` | |
| `budget` | | excluded: a group; its verb is the row below |
| `budget status` | `waitingQueue` | the slot and budget figures are scheduler internals |
| `daemon` | | excluded: a group; its verbs are the rows below |
| `daemon status` | `daemonStatus` | |
| `daemon install` | | excluded: installs this machine's launchd agent, a setup step |
| `daemon uninstall` | | excluded: removes this machine's launchd agent, a setup step |
| `daemon restart` | | excluded: restarts the daemon process the SDK talks to |
| `metrics rebuild` | | excluded: a one-off backfill of this machine's event log, a setup step |
| `start-args` | `startArgs` | |
| `internal wait-load` | | excluded: the throttle `with-temp-home` runs before a command |
| `internal gate` | | excluded: a Claude Code hook; reads hook JSON on stdin |
| `internal pr-guard` | | excluded: a Claude Code hook; reads hook JSON on stdin |
| `internal agent-state` | `clearNotice` | a Claude Code hook; `clearNotice` clears what it records |
| `internal session-end` | | excluded: a Claude Code hook; reads hook JSON on stdin |
| `internal reap` | | excluded: the daemon's scheduled idle sweep across every workspace |
| `internal dashboard` | | excluded: runs the dashboard server process |
| `internal mcp` | | excluded: the stdio transport to the daemon; the SDK calls the daemon with `callTool` |

Hidden aliases (each runs the command it names, so it has the same row): `up`, `down`, `restart`, `pause`, `resume`, `stop`, `status`, `services`, `logs`, `remove` (`feature drop`), `test`, `open` → `feature <verb>`; `starting-prompt` → `workspace prompt`; `list-workspaces`, `code`, `init-workspace` → `workspace <verb>`; `close-out` → `workspace close`; `remove-workspace` → `workspace abandon`; `intercept`, `connect`, `proxy-reload` → `infra <verb>`; `detect`, `clean`, `stats`, `optimize`, `setup`, `config`, `migrate` → `machine <verb>`; `wait-load` → `internal wait-load`; `hooks` → `internal gate`, `internal pr-guard`, `internal agent-state`; `dashboard` → `internal dashboard`; `mcp` → `internal mcp`.
