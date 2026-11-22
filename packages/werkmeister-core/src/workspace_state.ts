/**
 * The workspace state model (SW-487): a phase, an activity and a needs-you list, built from
 * facts the status sweep and the PR poll already read. Pure, so every UI renders the same
 * answer and every rule is tested without a workspace on disk.
 */
import {
  type AgentState,
  type Notice,
  SESSION_GONE_MS,
  type SessionRecord,
  sessionGone,
  type WaitingFile,
} from "./agent_state.js";
import type { Lifecycle } from "./pr_lifecycle.js";
import type { CrashLoop, Started } from "./resources.js";
import type { IcmStage, RepoPr, ServiceHealth } from "./sandbox.js";

export type PhaseId =
  | "building"
  | "pr-open"
  | "merged"
  | "released"
  | "ready-to-close"
  | "closed"
  | "abandoned";
export interface Phase {
  id: PhaseId;
  label: string;
  /** "Stage 2 of 4 · spec" or "JIT · test" while building; else null. */
  stage: string | null;
}

export type ActivityId =
  | "paused"
  | "queued"
  | "starting"
  | "testing"
  | "tool"
  | "subagent"
  | "thinking"
  | "gone"
  | "idle";
export interface Activity {
  id: ActivityId;
  label: string;
  since: string | null;
  session: string | null;
}

export type NeedKind =
  | "question"
  | "permission"
  | "plan"
  | "gate"
  | "ci-failed"
  | "conflict"
  | "changes-requested"
  | "merge"
  | "postmortem"
  | "close"
  | "crash-loop"
  | "session-died"
  | "notice";
export type NeedSource = "session" | "gate" | "pr" | "lifecycle" | "containers" | "notice" | "text";
export interface NeedItem {
  /** `<kind>:<session, file, repo or notice id>`: a UI key, and what a dismiss names. */
  id: string;
  kind: NeedKind;
  what: string;
  since: string | null;
  action: string;
  source: NeedSource;
  session?: string;
  file?: string;
  url?: string;
  /** A stored notice's id, for `clearNotice`: set only on items the person can dismiss. */
  dismiss?: string;
}

/** The card's one word for the agent (`◌ Working`, `● Needs you`, `✓ Done`, `Idle`) and since when. */
export interface AgentChip {
  id: AgentState;
  since: string | null;
}

export type StalledReason = "idle" | "capacity-wait" | "crash-loop" | "session-died";
/** Why a workspace stopped making progress without asking a person (SW-1007), and since when. */
export interface Stalled {
  reason: StalledReason;
  since: string | null;
}
export const STALLED_DEFAULT_MS = 30 * 60_000;
/** The idle limit while a tool call runs, foreground (SW-1037) or a background shell (SW-1047). */
export const STALLED_TOOL_DEFAULT_MS = 90 * 60_000;

export interface WorkspaceState {
  phase: Phase;
  activity: Activity;
  needs: NeedItem[];
  agent: AgentChip;
  /** Working with no session write past the idle limit, queued for capacity past the wait limit, a crash loop or a dead session; else null. A need for a person is not stalled. */
  stalled: Stalled | null;
  /** Age in ms of the oldest item in `needs` that has a `since`; null when none has. */
  oldestNeedMs: number | null;
}

export interface StateFacts {
  now: Date;
  /** The harness's session signal (hook records, else the transcript tail): the agent word before the list and activity overrule it. */
  signal: { agent: AgentState; at: string | null };
  sessions: Record<string, SessionRecord>;
  /** A claude-send turn this process runs. */
  turnRunning: boolean;
  /** An interactive session process is open in the workspace; null when the probe can't tell. */
  processOpen: boolean | null;
  paused: { at: string } | null;
  waiting: WaitingFile | null;
  services: { name: string; state: ServiceHealth }[];
  crashLoops: CrashLoop[];
  started: Started | null;
  lifecycle: Lifecycle;
  /** `postmortem.md`'s mtime, or null when there is none. */
  postmortemAt: string | null;
  /** When the last PR shipped, or null when unknown. */
  releasedAt: string | null;
  closedOut: boolean;
  stage: IcmStage | null;
  jitPhase: string | null;
  gates: { file: string; at: string }[];
  heldWakes: { session: string; at: string }[];
  /** PR files whose `registry_sync` reads `needed` (SW-340). */
  registrySync: { repo: string; url: string | null }[];
  notices: Record<string, Notice>;
  /** The transcript-tail guess, used only when no session has a record (pre-SW-46, or a session outside the workspace). */
  transcriptAsk: { what: string; at: string } | null;
  /** `autonomous` in workspace.yml: the agent approves its own stage gates; PR files stay the person's (SW-771). */
  autonomous: boolean;
  /** When the newest session file was last written; null or unset when unknown. */
  lastActivity?: string | null;
  /** The stalled limits; {@link STALLED_DEFAULT_MS} each when unset, {@link STALLED_TOOL_DEFAULT_MS} for `toolMs`. */
  stalledAfter?: { idleMs: number; waitMs: number; toolMs?: number };
}

const BEFORE_RELEASE = new Set<PhaseId>(["building", "pr-open", "merged"]);
// While the agent is still on something, a proposed gate is its draft, not handed over (SW-570),
// and the badge reads working rather than done (SW-681).
const STILL_ON_IT = new Set<ActivityId>([
  "queued",
  "starting",
  "testing",
  "tool",
  "subagent",
  "thinking",
]);
// A session's own work, so it outranks an idle signal too (SW-953); containers starting or a queue place don't.
const SESSION_WORK = new Set<ActivityId>(["testing", "tool", "subagent", "thinking"]);
const NOT_THE_SESSION = new Set<ActivityId>(["paused", "queued", "starting"]);
// shortcut: a command-text match, not the registry's `test:` commands (reading the registry costs every poll); add those if a runner is missed.
const TEST_COMMAND =
  /\bwerkmeister\s+(pr\s+gate|test)\b|\b(turbo|pnpm|npm|yarn|bun)\b.*\btest\b|\bnode\s+--test\b|\b(vitest|jest|pytest|playwright\s+test|go\s+test|cargo\s+test)\b/;

function phaseOf(f: StateFacts): Phase {
  const p = (id: PhaseId, label: string, stage: string | null = null): Phase => ({
    id,
    label,
    stage,
  });
  if (f.closedOut) return p("closed", "Closed");
  if (f.lifecycle === "abandoned")
    return f.postmortemAt ? p("ready-to-close", "Ready to close") : p("abandoned", "Abandoned");
  if (f.lifecycle === "shipped")
    return f.postmortemAt ? p("ready-to-close", "Ready to close") : p("released", "Released");
  if (f.lifecycle === "merged") return p("merged", "Merged, waiting for release");
  if (f.lifecycle === "pr-open") return p("pr-open", "PR open");
  const stage = f.stage
    ? `Stage ${f.stage.index} of ${f.stage.total} · ${f.stage.name}`
    : f.jitPhase
      ? `JIT · ${f.jitPhase}`
      : null;
  return p("building", stage ?? "Building", stage);
}

const queuedLabel = (w: WaitingFile) => `Queued for capacity (position ${w.position})`;

// The CLI's `<noun>` groups (apps/cli/src/main.ts NOUNS): only these take a second word.
const CLI_NOUNS = new Set([
  "feature",
  "workspace",
  "ws",
  "pr",
  "issue",
  "infra",
  "machine",
  "budget",
  "daemon",
  "internal",
]);

/**
 * "pr open" for `werkmeister pr open --watch`, "up" for `werkmeister up sw-681`; else the command,
 * cut for a card. Only at a command's start: every code worktree is named `werkmeister` (SW-690).
 */
function backgroundWhat(command: string): string {
  const m = command.match(/(?:^|[;&|])\s*werkmeister\s+([a-z][\w-]*)(?:\s+([a-z][\w-]*))?/);
  if (m?.[1]) return m[2] && CLI_NOUNS.has(m[1]) ? `${m[1]} ${m[2]}` : m[1];
  return command.length > 40 ? `${command.slice(0, 39)}…` : command;
}

function activityOf(f: StateFacts): Activity {
  const a = (
    id: ActivityId,
    label: string,
    since: string | null = null,
    session: string | null = null,
  ) => ({
    id,
    label,
    since,
    session,
  });
  if (f.paused) return a("paused", "Paused", f.paused.at);
  // A service-start wait (SW-540) holds only that start; the session keeps working (SW-569).
  if (f.waiting && !f.waiting.services) return a("queued", queuedLabel(f.waiting));
  if (f.services.some((s) => s.state === "starting"))
    return a("starting", "Containers starting", f.started?.at ?? null);
  const now = f.now.getTime();
  // A busy session past the limit counts as live while its process is still open (a long test run).
  const live = Object.entries(f.sessions).filter(
    ([, s]) => s.status === "busy" && (!sessionGone(s, now) || f.processOpen === true),
  );
  for (const [id, s] of live)
    if (s.tool?.name === "Bash" && TEST_COMMAND.test(s.tool.command ?? ""))
      return a("testing", "Running tests", s.tool.at, id);
  for (const [id, s] of live) if (s.tool) return a("tool", `Running ${s.tool.name}`, s.tool.at, id);
  // A background agent outlives its parent's turn, so an idle parent counts too, while not silent past the limit.
  const sub = Object.entries(f.sessions).find(
    ([, s]) => s.subagents && now - Date.parse(s.last ?? s.at) < SESSION_GONE_MS,
  );
  if (sub) return a("subagent", "Background agent running", sub[1].last ?? sub[1].at, sub[0]);
  // The newest hook event, not the turn's start: a 6 h turn heard from a minute ago is not "6 h ago" (SW-953).
  if (live.length) return a("thinking", "Thinking", live[0][1].last ?? live[0][1].at, live[0][0]);
  if (f.turnRunning) return a("thinking", "Thinking");
  // A background shell outlives its turn too (SW-570). A turn that stops after starting it writes nothing
  // more, so it stays a SESSION_GONE_MS past toolMs to read stalled before it is taken for a missed exit (SW-1047).
  const shellMs = (f.stalledAfter?.toolMs ?? STALLED_TOOL_DEFAULT_MS) + SESSION_GONE_MS;
  for (const [id, s] of Object.entries(f.sessions))
    if (s.shell && now - Date.parse(s.shell.at) < shellMs)
      return TEST_COMMAND.test(s.shell.command)
        ? a("testing", "Running tests", s.shell.at, id)
        : a("tool", `Running in background: ${backgroundWhat(s.shell.command)}`, s.shell.at, id);
  // Only a service-start wait gets here: a live session's activity wins over it (SW-569).
  if (f.waiting) return a("queued", queuedLabel(f.waiting));
  const gone = Object.entries(f.sessions).find(([, s]) => sessionGone(s, now));
  if (gone) return a("gone", "Session gone", gone[1].last ?? gone[1].at, gone[0]);
  return a("idle", "Idle");
}

const ASK_ACTION = {
  question: "Answer it",
  permission: "Approve or deny",
  plan: "Approve the plan",
};

export function workspaceState(f: StateFacts): WorkspaceState {
  const phase = phaseOf(f);
  const activity = activityOf(f);
  const needs: NeedItem[] = [];
  const need = (n: NeedItem) => needs.push(n);

  // A paused session's last ask is not news: Resume is what it waits on.
  if (!f.paused) {
    for (const [session, s] of Object.entries(f.sessions))
      if (s.ask)
        need({
          id: `${s.ask.kind}:${session}`,
          kind: s.ask.kind,
          what: s.ask.what,
          since: s.ask.at,
          action: ASK_ACTION[s.ask.kind],
          source: s.ask.source,
          session,
        });
    if (f.transcriptAsk && !Object.keys(f.sessions).length)
      need({
        id: "question:transcript",
        kind: "question",
        what: f.transcriptAsk.what,
        since: f.transcriptAsk.at,
        action: ASK_ACTION.question,
        source: "text",
      });
  }
  // SW-771: an autonomous run self-checks its stage gates but the person approves its PR files.
  const personsGate = (file: string) => !f.autonomous || /(^|\/)pr-[^/]*\.md$/.test(file);
  const handedOver = !STILL_ON_IT.has(activity.id);
  for (const g of handedOver ? f.gates.filter((g) => personsGate(g.file)) : [])
    need({
      id: `gate:${g.file}`,
      kind: "gate",
      what: `Approve ${g.file}`,
      since: g.at,
      action: "Read it, then set its status to approved or decided",
      source: "gate",
      file: g.file,
    });
  if (activity.id === "gone" && BEFORE_RELEASE.has(phase.id))
    need({
      id: `session-died:${activity.session}`,
      kind: "session-died",
      what: "The session stopped with work unfinished",
      since: activity.since,
      action: "Resume the session",
      source: "session",
      ...(activity.session && { session: activity.session }),
    });
  if (phase.id === "released")
    need({
      id: "postmortem:workspace",
      kind: "postmortem",
      what: "Released",
      since: f.releasedAt,
      action: "Run the postmortem",
      source: "lifecycle",
    });
  if (phase.id === "ready-to-close")
    need({
      id: "close:workspace",
      kind: "close",
      what: "Postmortem written",
      since: f.postmortemAt,
      action: "Close the workspace",
      source: "lifecycle",
    });
  for (const c of f.crashLoops)
    need({
      id: `crash-loop:${c.service}`,
      kind: "crash-loop",
      what: `${c.service} is crash-looping (${c.restarts} restarts)`,
      since: f.started?.at ?? null,
      action: "Look at its logs",
      source: "containers",
    });
  for (const w of f.heldWakes)
    need({
      id: `notice:wake-${w.session}`,
      kind: "notice",
      what: "A PR update is waiting for your open session",
      since: w.at,
      action: "Send that session a message, or let it finish its turn",
      source: "notice",
      session: w.session,
    });
  for (const r of f.registrySync)
    need({
      id: `notice:registry-${r.repo}`,
      kind: "notice",
      what: `Registry sync needed: the ${r.repo} fragment changed`,
      since: null,
      action: "Run werkmeister registry sync",
      source: "notice",
      ...(r.url && { url: r.url }),
    });
  // Stored notices are auto-fix blocks on an open PR; once it merges they are moot.
  if (phase.id === "building" || phase.id === "pr-open")
    for (const [id, n] of Object.entries(f.notices))
      need({
        id: `notice:${id}`,
        kind: "notice",
        what: n.what,
        since: n.at,
        action: n.action,
        source: "notice",
        ...(n.url && { url: n.url }),
        dismiss: id,
      });
  const agent = agentChip(f.signal, activity, needs);
  const now = f.now.getTime();
  const ages = needs.filter((n) => n.since).map((n) => now - Date.parse(n.since as string));
  return {
    phase,
    activity,
    needs,
    agent,
    stalled: stalledOf(f, activity, agent, needs),
    oldestNeedMs: ages.length ? Math.max(...ages) : null,
  };
}

/** The first of SW-1007's rules that holds, in the ticket's order; each limit is "older than", so exactly at it is not stalled. */
function stalledOf(
  f: StateFacts,
  activity: Activity,
  agent: AgentChip,
  needs: NeedItem[],
): Stalled | null {
  const {
    idleMs,
    waitMs,
    toolMs = STALLED_TOOL_DEFAULT_MS,
  } = f.stalledAfter ?? {
    idleMs: STALLED_DEFAULT_MS,
    waitMs: STALLED_DEFAULT_MS,
  };
  const age = (at: string) => f.now.getTime() - Date.parse(at);
  // A queue place or a container start reads working too (STILL_ON_IT) but writes no transcript: not idle.
  const sessionWorking = agent.id === "working" && !NOT_THE_SESSION.has(activity.id);
  // SW-1037: Claude writes nothing during one tool call, so a 35-min gate would read idle at 30; a hung one still trips toolMs.
  const idleLimit = activity.id === "testing" || activity.id === "tool" ? toolMs : idleMs;
  if (sessionWorking && f.lastActivity && age(f.lastActivity) > idleLimit)
    return { reason: "idle", since: f.lastActivity };
  if (f.waiting?.since && age(f.waiting.since) > waitMs)
    return { reason: "capacity-wait", since: f.waiting.since };
  const crash = needs.find((n) => n.kind === "crash-loop" || n.kind === "session-died");
  return crash ? { reason: crash.kind as StalledReason, since: crash.since } : null;
}

/** The needs-you items and phase detail the PR poll adds, one set per workspace. */
export function prNeeds(prs: RepoPr[]): { needs: NeedItem[]; phaseDetail: string | null } {
  const needs: NeedItem[] = [];
  const open = prs.filter((p) => p.state === "OPEN" && p.url);
  for (const p of open) {
    const base = { source: "pr" as const, url: p.url as string };
    if (p.ci === "fail")
      needs.push({
        ...base,
        id: `ci-failed:${p.repo}`,
        kind: "ci-failed",
        what: `CI failed on ${p.repo} (${p.failingChecks} failing)`,
        since: p.ciAt ?? null,
        action: "Tell the workspace to fix CI",
      });
    if (p.mergeable === "CONFLICTING")
      needs.push({
        ...base,
        id: `conflict:${p.repo}`,
        kind: "conflict",
        what: `${p.repo} PR conflicts with its base`,
        since: null,
        action: "Tell the workspace to rebase",
      });
    if (p.review === "CHANGES_REQUESTED")
      needs.push({
        ...base,
        id: `changes-requested:${p.repo}`,
        kind: "changes-requested",
        what: `Review asked for changes on ${p.repo}`,
        since: p.reviewAt ?? null,
        action: "Tell the workspace to address the review",
      });
    if (!p.draft && p.ci === "pass" && p.review === "APPROVED" && p.mergeable !== "CONFLICTING")
      needs.push({
        ...base,
        id: `merge:${p.repo}`,
        kind: "merge",
        what: `${p.repo} PR is approved and green`,
        since: p.reviewAt ?? null,
        action: "Merge it",
      });
  }
  const detail = [
    open.some((p) => p.review === "REVIEW_REQUIRED") && "waiting on review",
    open.some((p) => p.behind) && "behind main",
  ].filter(Boolean);
  return { needs, phaseDetail: detail.length ? detail.join(" · ") : null };
}

/**
 * Needs you whenever the list has an item (SW-487 Q8); a done turn reads working while the activity is (SW-681),
 * an idle one while the session itself works (SW-953);
 * else what the sessions say. Paused: the signal, which every surface shows as Paused anyway.
 */
function agentChip(signal: StateFacts["signal"], activity: Activity, needs: NeedItem[]): AgentChip {
  const own = { id: signal.agent, since: signal.at };
  const first = needs[0];
  if (activity.id === "paused") return own;
  if (!first) {
    const working =
      (signal.agent === "done" && STILL_ON_IT.has(activity.id)) ||
      (signal.agent === "idle" && SESSION_WORK.has(activity.id));
    return working ? { id: "working", since: activity.since ?? signal.at } : own;
  }
  return signal.agent === "needs-you" ? own : { id: "needs-you", since: first.since };
}
