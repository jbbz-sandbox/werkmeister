/**
 * The exported functions, types and errors of the werkmeister SDK.
 * @module
 */

export { clearNotice } from "./agent_state.js";
export {
  type CacheSnapshot,
  type PruneDeps,
  type PruneOptions,
  type PruneResult,
  pruneCaches,
} from "./build_caches.js";
export type { LogTail } from "./compose.js";
export type { CacheEntry, CacheRegistry } from "./config.js";
// The daemon's HTTP API.
export {
  callTool,
  type DaemonStatus,
  DaemonUnavailable,
  daemonStatus,
  daemonUrl,
  streamLogs,
  type ToolResult,
} from "./daemon_client.js";
export { type ContainerStat, containerStats } from "./docker.js";
export { SandboxError, WorkspaceError } from "./errors.js";
export type { HostLookup } from "./feature_routing.js";
export type { FormBundle } from "./form_schema.js";
export { portsPerSlot } from "./fragment_detect/allocate.js";
export type { QuestionKind } from "./fragment_detect/assist.js";
export { stdoutRunner } from "./fragment_detect/files.js";
// Detect: plan a repo's services.yaml fragment, ask about what is unsure, write it.
export {
  type Answer,
  type ApplyResult,
  applyAnswers,
  collectQuestions,
  planFragment,
  planSummary,
  type Question,
  renderFragment,
  validateFragment,
  writeFragment,
} from "./fragment_detect/index.js";
export type { Plan, PlanOptions } from "./fragment_detect/plan.js";
export type { ResolvedInfra, ResolvedService } from "./fragment_detect/precedence.js";
export type { Rendered } from "./fragment_detect/render.js";
export type { Confidence, FieldValue, Skipped } from "./fragment_detect/types.js";
export { type GraduateNoteOptions, GraduationError, graduateNote } from "./graduate.js";
export { relayPickedUp } from "./harness/claude/session.js";
export { harnessLayoutFor } from "./harness/layout.js";
export type {
  HarnessId,
  HarnessLayout,
  HooksSupport,
  SessionMessage,
  SessionTranscript,
  TurnOptions,
  TurnResult,
  TurnStatus,
  WorkspaceUsage,
} from "./harness/types.js";
// The shared infrastructure (Caddy, k8s port-forwards), not a workspace's own stack.
export {
  connectK8s,
  down as infraDown,
  infraHealth,
  restart as infraRestart,
  stop as infraStop,
  up as infraUp,
} from "./infra.js";
export type { IssueSnapshot } from "./issue_snapshot.js";
export { type IssueStatuses, startIssue } from "./issue_status.js";
export { issueTracker, type TrackerAt } from "./issue_tracker.js";
export type { Issue, IssueTrackerStrategy } from "./issue_trackers/types.js";
export type { ForwardStatus } from "./k8s.js";
export type { Launcher } from "./launcher.js";
export {
  type CleanPlan,
  type CleanResult,
  type ProxyOps,
  type ProxyReloadResult,
  planClean,
  type RemoveResult,
  type ResumeResult,
  readServicesFromWorkspace,
  reloadProxy,
  removeService,
  runClean,
} from "./lifecycle.js";
export type { Runner, Step } from "./machine_setup.js";
export {
  type MetricsReport,
  type MetricsTrends,
  metricsReport,
  metricsTrends,
} from "./metrics_report.js";
export { type MigrateOptions, migrate } from "./migrate.js";
export { listNotes, type Note, parseNote } from "./notes.js";
export {
  adoptPr,
  autosquash,
  type Deps,
  defaultDeps,
  gatePrs,
  type Lifecycle,
  newPr,
  openPrs,
  type PrCallback,
  type PrView,
  pushPrs,
} from "./pr_lifecycle.js";
export type { RunResult } from "./proc.js";
export { type SyncRegistryOptions, syncRegistry } from "./registry_sync.js";
export type { HostSummary, Usage, WorkspaceResources } from "./resources.js";
export type { StartArgs } from "./run_start.js";
// Workspaces: list, read state, create, close.
export {
  applyIssueFormAnswer,
  approvePr,
  buildIssueFormRequest,
  buildRefinePrompt,
  type CheckInTriage,
  type CreateOptions,
  type CreateResult,
  checkInTriage,
  claimResumeNudge,
  closeOut,
  createWorkspace,
  type FormSchemaBundle,
  fetchIssueCard,
  fetchIssueFormData,
  followLogsInTerminal,
  getClaudeTranscript,
  getClaudeTurnStatus,
  getDockerUi,
  getFormSchema,
  getIssueStatuses,
  getK8sForwardsHealth,
  getKubeContext,
  getOpenPrs,
  getWorkspacePRs,
  getWorkspaceResources,
  getWorkspaceStatuses,
  getWorkspaceUsage,
  type IcmStage,
  type InfraStatus,
  icmStage,
  type K8sForwardHealth,
  type KubeEnv,
  type KubeSwitchEnv,
  launchPrReconcile,
  lifecycleOf,
  listSessions,
  listWorkspaces,
  mergeFormData,
  type OpenPrsResult,
  openFeatureBrowser,
  openWorkspace,
  postSlackReviewRequest,
  refinePrompt,
  refreshPrStatus,
  resolveWorkspaceDir,
  restoreResumeNudge,
  resumeAndNudge,
  resumeClaudeInTerminal,
  runWorkspaceAction,
  sendToClaudeSession,
  startArgs,
  switchKubeContext,
  validateFormData,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  type WorkspaceEntry,
  type WorkspacePrs,
  type WorkspaceStatus,
  watchPrs,
} from "./sandbox.js";
export { schedulerOp, waitingQueue } from "./scheduler_client.js";
export { type FeatureServices, featureServices, type ServiceEndpoint } from "./slots.js";
export { checkStandards, type StandardsCheck } from "./standards.js";
export {
  type CollectionRun,
  type ContainerStats,
  type OptimizeReport,
  optimizeReport,
  type Recommendation,
  runCollection,
  type ServiceUsage,
} from "./stats.js";
export {
  type FeatureSnapshot,
  type InfraContainer,
  type InterceptRow,
  type InterceptsSnapshot,
  interceptsSnapshot,
  type StatusSnapshot,
  statusSnapshot,
} from "./status.js";
export { strategyFor } from "./strategies/index.js";
export type {
  ContextStrategy,
  DecisionSource,
  InitContext,
  StrategyId,
} from "./strategies/types.js";
export {
  type InterceptArgs,
  type InterceptResult,
  type LeaveInterceptArgs,
  leaveIntercept,
  startIntercept,
} from "./telepresence.js";
export { runFeatureTests, type TestRunArgs, type TestRunResult } from "./test_run.js";
export type { WebServerStatus } from "./web_servers.js";
export { type InitWorkspaceOptions, initWorkspace } from "./workspace_init.js";
export { revokeWorkspaceToken, staleTokens } from "./workspace_token.js";
