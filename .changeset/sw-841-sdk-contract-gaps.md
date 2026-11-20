---
"werkmeister": patch
---

The `werkmeister-core/sdk` entry now exports the types its public members use, so callers can name them: `Runner`, `Deps`, `InitContext`, `CacheRegistry`, `CacheEntry`, `CacheSnapshot`, `RunResult`, `HostLookup`, `ContainerStats`, `Recommendation`, `ServiceUsage`, `ServiceEndpoint`, `Usage`, `HostSummary`, `FeatureSnapshot`, `InfraContainer`, `ForwardStatus`, `WebServerStatus`, `InterceptRow`, `DecisionSource`, `StrategyId`, `IssueSnapshot`, `QuestionKind`, `ResolvedService`, `ResolvedInfra`, `HooksSupport` and `HarnessId`, plus `stdoutRunner`, `portsPerSlot`, `defaultDeps` and `GraduationError`. Other contract fixes:

- `infraDown`, `infraStop` and `infraRestart` resolve `true` or `false`, as `infraUp` does, instead of only logging a Docker failure.
- `staleTokens` throws `WorkspaceError`, and `initWorkspace`'s "not inside a workspace" error is a `WorkspaceError`.
- `syncRegistry` returns a failing step, instead of throwing, when it can't read the registry or back up a hand-written one; with no backup it leaves the hand-written registry in place.
- `getClaudeTranscript`, `getClaudeTurnStatus` and `relayPickedUp` are typed `SessionTranscript`, `TurnStatus` and `SessionMessage[]`, and `getClaudeTurnStatus` asks the workspace's own harness.
- `graduateNote` takes a `Note`.
