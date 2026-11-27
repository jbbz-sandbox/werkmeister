/**
 * The exported functions, types and errors of the werkmeister SDK.
 * @module
 */

export { type AgentState, clearNotice } from "./agent_state.js";
export {
  type CacheSnapshot,
  type PruneDeps,
  type PruneOptions,
  type PruneResult,
  pruneCaches,
} from "./build_caches.js";
export type { ContainerStatus, LogTail } from "./compose.js";
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
export type { FormBundle, SchemaProp } from "./form_schema.js";
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
export type { Plan, PlanOptions, SetupPlan } from "./fragment_detect/plan.js";
export type {
  Conflict,
  ResolvedInfra,
  ResolvedService,
} from "./fragment_detect/precedence.js";
export type { Rendered } from "./fragment_detect/render.js";
export type {
  Confidence,
  FieldValue,
  Finding,
  FindingKind,
  Skipped,
} from "./fragment_detect/types.js";
export { type GraduateNoteOptions, GraduationError, graduateNote } from "./graduate.js";
export { type ClaudeSessionSignal, relayPickedUp } from "./harness/claude/session.js";
export { harnessLayoutFor } from "./harness/layout.js";
export type {
  HarnessId,
  HarnessLayout,
  HooksSupport,
  ModelUsage,
  SessionMessage,
  SessionSignal,
  SessionTranscript,
  SessionUsage,
  TurnOptions,
  TurnResult,
  TurnStatus,
  UsageTotals,
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
export { type IssuePoint, type IssueStatuses, startIssue } from "./issue_status.js";
export { issueTracker, type TrackerAt } from "./issue_tracker.js";
export type {
  Board,
  Issue,
  IssueComment,
  IssueKind,
  IssueParent,
  IssueTrackerStrategy,
  IssueUpdate,
  NewIssue,
  TrackerAuth,
} from "./issue_trackers/types.js";
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
export type { PrWatchScheduleOptions, Runner, Step } from "./machine_setup.js";
export type { GateRowKind } from "./metrics.js";
export {
  type AbandonedSpend,
  type CostlyTicket,
  type CountedPercentiles,
  type FlowCard,
  type FlowColumn,
  type FlowColumnReport,
  type MetricsRange,
  type MetricsReport,
  type MetricsTrends,
  type ModelRollup,
  metricsReport,
  metricsTrends,
  type Percentiles,
  type SlowTicket,
  type StageTrend,
  type SuiteTrend,
  type TicketCost,
  type TicketTimes,
  type TimelineEvent,
  type TrendBucket,
  type TrendRow,
  type TrendSlice,
  type UsageRollup,
  type WaitCause,
  type WaitSeconds,
  type WorkTypeColumn,
  type WorkTypeSlice,
} from "./metrics_report.js";
export { type MigrateOptions, migrate, type RunningContainer } from "./migrate.js";
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
  prPushDir,
  pushPrs,
  watchPushedPrs,
} from "./pr_lifecycle.js";
export type { RunResult } from "./proc.js";
export { type SyncRegistryOptions, syncRegistry } from "./registry_sync.js";
export type {
  CrashLoop,
  HostSummary,
  Started,
  StartedBy,
  Usage,
  WorkspaceResources,
} from "./resources.js";
export type { StartArgs } from "./run_start.js";
// Workspaces: list, read state, create, close.
export {
  applyIssueFormAnswer,
  approvePr,
  buildIssueFormRequest,
  buildRefinePrompt,
  type CheckInRow,
  type CheckInTriage,
  type CreateOptions,
  type CreateResult,
  checkInTriage,
  claimResumeNudge,
  closeOut,
  createWorkspace,
  type Distiller,
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
  type OpenPr,
  type OpenPrsResult,
  openFeatureBrowser,
  openWorkspace,
  postSlackReviewRequest,
  type RepoPr,
  type ReviewStatus,
  refinePrompt,
  refreshPrStatus,
  resolveWorkspaceDir,
  restoreResumeNudge,
  resumeAndNudge,
  resumeClaudeInTerminal,
  runWorkspaceAction,
  type ServiceHealth,
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
  type UsageStatus,
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
  IssueRef,
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
export type {
  Activity,
  ActivityId,
  AgentChip,
  NeedItem,
  NeedKind,
  NeedSource,
  Phase,
  PhaseId,
  Stalled,
  StalledReason,
  WorkspaceState,
} from "./workspace_state.js";
export { revokeWorkspaceToken, staleTokens } from "./workspace_token.js";
