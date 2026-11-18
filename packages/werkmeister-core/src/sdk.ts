/**
 * The exported functions, types and errors of the werkmeister SDK.
 * @module
 */

export { clearNotice } from "./agent_state.js";
export {
  type PruneDeps,
  type PruneOptions,
  type PruneResult,
  pruneCaches,
} from "./build_caches.js";
export type { LogTail } from "./compose.js";
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
export type { FormBundle } from "./form_schema.js";
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
export type { Rendered } from "./fragment_detect/render.js";
export type { Confidence, FieldValue, Skipped } from "./fragment_detect/types.js";
export { type GraduateNoteOptions, graduateNote } from "./graduate.js";
export { relayPickedUp } from "./harness/claude/session.js";
export { harnessLayoutFor } from "./harness/layout.js";
export type {
  HarnessLayout,
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
export { type IssueStatuses, startIssue } from "./issue_status.js";
export { issueTracker, type TrackerAt } from "./issue_tracker.js";
export type { Issue, IssueTrackerStrategy } from "./issue_trackers/types.js";
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
export type { Step } from "./machine_setup.js";
export { type MigrateOptions, migrate } from "./migrate.js";
export { listNotes, type Note, parseNote } from "./notes.js";
export {
  adoptPr,
  gatePrs,
  type Lifecycle,
  newPr,
  openPrs,
  type PrCallback,
  type PrView,
  pushPrs,
} from "./pr_lifecycle.js";
export { type SyncRegistryOptions, syncRegistry } from "./registry_sync.js";
export type { WorkspaceResources } from "./resources.js";
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
export { type FeatureServices, featureServices } from "./slots.js";
export { checkStandards, type StandardsCheck } from "./standards.js";
export { type CollectionRun, type OptimizeReport, optimizeReport, runCollection } from "./stats.js";
export {
  type InterceptsSnapshot,
  interceptsSnapshot,
  type StatusSnapshot,
  statusSnapshot,
} from "./status.js";
export { strategyFor } from "./strategies/index.js";
export type { ContextStrategy } from "./strategies/types.js";
export {
  type InterceptArgs,
  type InterceptResult,
  type LeaveInterceptArgs,
  leaveIntercept,
  startIntercept,
} from "./telepresence.js";
export { runFeatureTests, type TestRunArgs, type TestRunResult } from "./test_run.js";
export { type InitWorkspaceOptions, initWorkspace } from "./workspace_init.js";
export { revokeWorkspaceToken, staleTokens } from "./workspace_token.js";
