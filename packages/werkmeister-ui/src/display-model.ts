/**
 * Workspace data → the words, tones and glyphs every surface shows (SW-49). No
 * DOM and no runtime imports, so the pane (Claude Code's `Box`/`Text`) and the
 * VS Code tree read the same labels as the React card. Wording follows
 * `docs/ui-spec.md` § The card; where `docs/design/workspace-card` differs, the
 * spec wins. Tones are names: each surface maps them to its own colours.
 */

import type {
  IcmStage,
  Lifecycle,
  NeedItem,
  RepoPr,
  WorkspaceState,
  WorkspaceStatus,
} from "werkmeister-core";

/** `needs` is the solid-amber chip, used only for Needs you. */
export type Tone = "ok" | "warn" | "err" | "off" | "pr" | "needs";

export type AgentState = WorkspaceState["agent"]["id"];
export type ServiceHealth = WorkspaceStatus["services"][number]["state"];

/** The fields read from a `WorkspaceStatus`; a full one satisfies it. */
export interface DisplayInput {
  state: WorkspaceStatus["state"];
  running: number;
  total: number;
  services: { name: string; state: ServiceHealth }[];
  stage: IcmStage | null;
  phase: string | null;
  autonomous: boolean;
  lastActivity: string | null;
  /** SW-41; optional so a core older than it still renders. */
  started?: { at: string; by: string } | null;
  /** SW-70; optional so a core older than it still renders. */
  paused?: { at: string; containers: string[] } | null;
  crashLoops?: { service: string; restarts: number; lastLog: string | null }[];
  /** SW-487; optional so a core older than it still renders (as Idle, with no list). The agent word is its `agent` (SW-558). */
  workspaceState?: WorkspaceState | null;
  /** SW-577: the model the workspace runs; optional so a core older than it still renders. */
  model?: string | null;
}

/** One project's share of the stats sweep (core `Usage`). */
export interface UsageInput {
  cpuPercent: number;
  memMib: number;
}

/** Core `HostSummary`. */
export interface HostInput {
  load: number[];
  cores: number;
  featureCpuPercent: number;
}

/** A `RepoPr` satisfies it. Core reports neither drafts nor releases yet, so callers that know pass them. */
export interface PrInput {
  url: string | null;
  state: RepoPr["state"];
  ci: RepoPr["ci"];
  failingChecks: number;
  mergeable?: RepoPr["mergeable"];
  draft?: boolean;
  /** The release tag (`v0.14.0`) once the merged PR shipped. */
  release?: string | null;
}

export interface DisplayOptions {
  /** null when the PR lookup failed; omitted when the workspace has none. */
  prs?: PrInput[] | null;
  lifecycle?: Lifecycle | null;
  /** Where the newest session runs, for `↗ Continue in …`. */
  where?: "Desktop" | "Terminal";
  now?: Date;
  /** From the slower resources poll; omitted or null until one lands. */
  usage?: UsageInput | null;
  /** The PR poll's needs-you items and phase detail (core `WorkspacePrs`), listed after the sweep's. */
  prNeeds?: NeedItem[] | null;
  phaseDetail?: string | null;
}

/** One Needs-you row: `● <what> · <since> — <action>`. */
export interface NeedRow {
  id: string;
  what: string;
  action: string;
  /** `12 min ago`, or '' when the source has no time. */
  since: string;
  /** The reply-text guess, shown as one. */
  guess: boolean;
  url: string | null;
  /** The stored notice id a ✕ clears; null when the item clears itself. */
  dismiss: string | null;
}

/** `● <what> (guess) · <since> — <action>`: one wording for every surface that prints it as text (SW-962). */
export function needLine(n: NeedRow): string {
  return `● ${n.what}${n.guess ? " (guess)" : ""}${n.since ? ` · ${n.since}` : ""} — ${n.action}`;
}

export interface Text {
  text: string;
  tone: Tone;
}

export interface PrDisplay {
  /** `repo#N`, the owner dropped (ui-spec § Badges). */
  ref: string;
  url: string;
  state: Text & { dashed: boolean };
  ci: Text | null;
}

export interface WorkspaceDisplay {
  agent: {
    glyph: string;
    word: string;
    label: string;
    /** The header chip. */
    tone: Tone;
    /** The Agent row's dot; amber, not solid, for Needs you. */
    dot: Tone;
    codicon: string;
    time: string;
  };
  needs: boolean;
  question: string | null;
  /** SW-487: everything waiting on the person, oldest kinds first; empty with an older core. */
  needsList: NeedRow[];
  /** `Stage 2 of 4 · spec` / `PR open · waiting on review`; null with an older core. */
  phase: Text | null;
  /** `Running tests` and `4 min ago`; null with an older core. */
  activity: (Text & { time: string }) | null;
  autonomous: { full: string; compact: string } | null;
  /** The model the workspace runs (`opus`, `claude-opus-5-5`); null when it records none. */
  model: string | null;
  containers: Text;
  services: (Text & { name: string; glyph: string; codicon: string })[];
  /** `12.3% CPU · 410 MiB`. */
  usage: Text | null;
  /** `started 2 h ago by gate`. */
  started: Text | null;
  /** `✗ api crash-looping · 4 restarts · <last log line>`, one per service joined by `; `. */
  crash: Text | null;
  /** The PRs row when there is no PR to list: `None yet` or `PRs unavailable`. */
  prsEmpty: Text | null;
  prs: PrDisplay[];
  workflow: {
    kind: "lifecycle" | "icm" | "jit" | "none";
    text: string;
    compact: string;
    pips: ("done" | "current" | "next")[];
  };
  primary: {
    action: "continue" | "close-out" | "up" | "resume";
    label: string;
    destructive: boolean;
  };
}

const AGENT: Record<
  AgentState,
  { glyph: string; word: string; tone: Tone; dot: Tone; codicon: string }
> = {
  "needs-you": {
    glyph: "●",
    word: "Needs you",
    tone: "needs",
    dot: "warn",
    codicon: "circle-filled",
  },
  working: { glyph: "◌", word: "Working", tone: "ok", dot: "ok", codicon: "sync" },
  done: { glyph: "✓", word: "Done", tone: "ok", dot: "ok", codicon: "pass" },
  idle: { glyph: "", word: "Idle", tone: "off", dot: "off", codicon: "circle-outline" },
};

/** Overrides every agent state while Pause holds the session: its last state is not news. */
const PAUSED = {
  glyph: "⏸",
  word: "Paused",
  tone: "off",
  dot: "off",
  codicon: "debug-pause",
} as const;

const SERVICE: Record<ServiceHealth, { glyph: string; tone: Tone; word: string; codicon: string }> =
  {
    healthy: { glyph: "●", tone: "ok", word: "", codicon: "circle-filled" },
    running: { glyph: "●", tone: "ok", word: "", codicon: "circle-filled" },
    down: { glyph: "○", tone: "off", word: "", codicon: "circle-outline" },
    starting: { glyph: "◐", tone: "warn", word: " starting", codicon: "loading" },
    unhealthy: { glyph: "▲", tone: "err", word: " unhealthy", codicon: "warning" },
  };

const CRASH_LOOP = { glyph: "✗", tone: "err", word: " crash-looping", codicon: "error" } as const;

const LIFECYCLE: Partial<Record<Lifecycle, string>> = {
  ready: "Ready to open PR",
  merged: "Awaiting release",
  shipped: "Ready to close out",
  "closed-out": "Closed out",
  abandoned: "Abandoned",
};

/** `12 s ago` · `12 min ago` · `5 h ago` · `2 days ago`; '' with no timestamp. */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

const NO_AGENT = { id: "idle", since: null } as const;

function agentTime(ws: DisplayInput, now: Date): string {
  const { id: agent, since: at } = ws.workspaceState?.agent ?? NO_AGENT;
  if (agent === "needs-you") return `asked a question ${ago(at, now)}`.trim();
  if (agent === "working") return `last activity ${ago(ws.lastActivity ?? at, now)}`.trim();
  if (agent === "done") return `idle since ${ago(at ?? ws.lastActivity, now)}`.trim();
  return "no live turn, nothing asked";
}

function containers(ws: DisplayInput): Text {
  const loops = ws.crashLoops ?? [];
  if (loops.length === 1) return { text: `${loops[0]?.service} crash-looping`, tone: "err" };
  if (loops.length > 1) return { text: `${loops.length} crash-looping`, tone: "err" };
  const count = `${ws.running} of ${ws.total} up`;
  if (ws.state === "up") return { text: count, tone: "ok" };
  if (ws.state === "partial") return { text: count, tone: "warn" };
  if (ws.state === "stopped") return { text: count, tone: "off" };
  if (ws.state === "paused") return { text: "paused", tone: "off" };
  if (ws.state === "down") return { text: "down", tone: "off" };
  return { text: "Docker unreachable", tone: "off" };
}

function crash(ws: DisplayInput): Text | null {
  const loops = ws.crashLoops ?? [];
  if (!loops.length) return null;
  const text = loops
    .map((l) =>
      [`✗ ${l.service} crash-looping`, l.restarts ? `${l.restarts} restarts` : null, l.lastLog]
        .filter(Boolean)
        .join(" · "),
    )
    .join("; ");
  return { text, tone: "err" };
}

function usage(u: UsageInput | null | undefined): Text | null {
  if (!u) return null;
  return {
    text: `${u.cpuPercent}% CPU · ${u.memMib} MiB`,
    tone: u.cpuPercent >= 100 ? "warn" : "ok",
  };
}

/** One workspace as the status strip counts it. `stalled` is SW-1007's signal: absent until it lands. */
export interface StripRow {
  name: string;
  ws: DisplayInput;
  prs?: PrInput[] | null;
  prNeeds?: NeedItem[] | null;
  stalled?: boolean;
}

/** SW-1006's `budget status`, in bytes; a null limit is uncapped. */
export interface BudgetInput {
  memory: number | null;
  cpus: number | null;
  used: { memory: number; cpus: number };
}

export interface StripGlobals {
  /** undefined: no sweep yet, so no host line; null: the sweep failed. */
  host?: HostInput | null;
  infra?: {
    state: "up" | "partial" | "down" | "unknown";
    services: { name: string; state: ServiceHealth }[];
  } | null;
  trackerAuth?: { ok: boolean; reason?: string } | null;
  budget?: BudgetInput | null;
}

export type ChipKind = "needs" | "stalled" | "running" | "waiting" | "infra" | "ci" | "auth";

export interface StripChip extends Text {
  kind: ChipKind;
  count: number;
  /** The first matching workspace, the card a click jumps to; null for infra and auth. */
  first: string | null;
}

export interface HostStrip extends Text {
  /** Each 0–1, clamped: the text carries a value over 100%. */
  meter: { host: number; features: number };
  tooltip: string;
}

/** The top of the workspaces views (SW-1008): chips shown only when non-zero, and the host line. */
export interface StatusStrip {
  chips: StripChip[];
  host: HostStrip | null;
}

const GIB = 1024 ** 3;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

function budgetText(b: BudgetInput | null | undefined): string {
  if (!b) return "";
  const mem =
    b.memory === null
      ? ""
      : ` · ${(b.used.memory / GIB).toFixed(1)} of ${Number((b.memory / GIB).toFixed(1))} GiB`;
  const cpus = b.cpus === null ? "" : ` · ${b.used.cpus} of ${b.cpus} CPUs`;
  return mem + cpus;
}

function hostStrip(h: HostInput | null | undefined, b: BudgetInput | null | undefined) {
  if (h === undefined) return null;
  if (h === null)
    return {
      text: "host n/a",
      tone: "off" as Tone,
      meter: { host: 0, features: 0 },
      tooltip: "host load unavailable",
    };
  const load1 = h.load[0] ?? 0;
  const features = h.featureCpuPercent / 100;
  const memory =
    b && b.memory !== null
      ? `\nmemory budget ${(b.used.memory / GIB).toFixed(1)} of ${Number((b.memory / GIB).toFixed(1))} GiB`
      : "";
  return {
    text: `host ${Math.round((load1 / h.cores) * 100)}% · features ${features.toFixed(1)} of ${h.cores} cores`,
    tone: (load1 > h.cores ? "warn" : "ok") as Tone,
    meter: { host: clamp(load1 / h.cores), features: clamp(features / h.cores) },
    tooltip: `load 1 · 5 · 15 min: ${h.load.join(" · ")} on ${h.cores} cores${memory}`,
  };
}

export function statusStrip(rows: StripRow[], g: StripGlobals = {}, now = new Date()): StatusStrip {
  const chips: StripChip[] = [];
  const chip = (kind: ChipKind, hits: StripRow[], text: string, tone: Tone) => {
    if (hits.length)
      chips.push({ kind, count: hits.length, text, tone, first: hits[0]?.name ?? null });
  };
  const needItems = (r: StripRow) =>
    r.ws.paused ? [] : [...(r.ws.workspaceState?.needs ?? []), ...(r.prNeeds ?? [])];
  const needing = rows.filter((r) => displayModel(r.ws, { prNeeds: r.prNeeds, now }).needs);
  const oldest = needing
    .flatMap(needItems)
    .map((n) => n.since)
    .filter((s): s is string => !!s)
    .sort()[0];
  const age = oldest ? ` · ${ago(oldest, now).replace(/ ago$/, "")}` : "";
  const n = needing.length;
  chip("needs", needing, `● ${n} ${n === 1 ? "needs" : "need"} you${age}`, "needs");
  const stalled = rows.filter((r) => r.stalled && !needing.includes(r));
  chip("stalled", stalled, `${stalled.length} stalled`, "err");
  const running = rows.filter((r) => r.ws.state === "up" || r.ws.state === "partial");
  chip("running", running, `${running.length} running`, "ok");
  const waiting = rows.filter((r) => r.ws.workspaceState?.activity.id === "queued");
  chip("waiting", waiting, `${waiting.length} waiting${budgetText(g.budget)}`, "warn");
  const infra = g.infra;
  if (infra) {
    const bad = infra.services.filter((s) => s.state !== "healthy" && s.state !== "running");
    if (infra.state === "unknown")
      chips.push({
        kind: "infra",
        count: 1,
        text: "infra: docker unreachable",
        tone: "err",
        first: null,
      });
    else if (bad.length)
      chips.push({
        kind: "infra",
        count: bad.length,
        text: `infra: ${bad.map((s) => `${s.name} ${s.state}`).join(", ")}`,
        // A start under way is no outage (SW-1069): warn until something is really down or unhealthy.
        tone: bad.every((s) => s.state === "starting") ? "warn" : "err",
        first: null,
      });
  }
  const red = rows.filter((r) =>
    (r.prs ?? []).some(
      (p) => p.state === "OPEN" && (p.ci === "fail" || p.mergeable === "CONFLICTING"),
    ),
  );
  chip("ci", red, `${red.length} CI failed or conflicts`, "err");
  if (g.trackerAuth?.ok === false)
    chips.push({ kind: "auth", count: 1, text: "tracker auth expired", tone: "warn", first: null });
  return { chips, host: hostStrip(g.host, g.budget) };
}

/** `https://github.com/o/repo/pull/12` → `repo#12`; the URL itself when it isn't one. */
function prRef(url: string): string {
  const m = url.match(/\/([^/]+)\/pull\/(\d+)/);
  return m ? `${m[1]}#${m[2]}` : url;
}

function prState(p: PrInput): Text & { dashed: boolean } {
  if (p.state === "OPEN")
    return p.draft
      ? { text: "Draft", tone: "off", dashed: true }
      : { text: "Open", tone: "ok", dashed: false };
  if (p.state === "MERGED")
    return { text: p.release ? `Released ${p.release}` : "Merged", tone: "pr", dashed: false };
  return { text: "Closed", tone: "off", dashed: false };
}

function ci(p: PrInput): Text | null {
  if (p.ci === "pass") return { text: "CI ✓", tone: "ok" };
  if (p.ci === "running") return { text: "CI running", tone: "warn" };
  if (p.ci === "fail") return { text: `CI ✗ ${p.failingChecks} failing`, tone: "err" };
  return null;
}

function workflow(ws: DisplayInput, lifecycle: Lifecycle | null): WorkspaceDisplay["workflow"] {
  const step = lifecycle ? LIFECYCLE[lifecycle] : undefined;
  if (step) return { kind: "lifecycle", text: step, compact: step, pips: [] };
  const s = ws.stage;
  if (s)
    return {
      kind: "icm",
      text: `Stage ${s.index} of ${s.total} · ${s.name}`,
      compact: `stage ${s.index}/${s.total} ${s.name}`,
      pips: Array.from({ length: s.total }, (_, i) =>
        i + 1 < s.index ? "done" : i + 1 === s.index ? "current" : "next",
      ),
    };
  if (ws.phase)
    return { kind: "jit", text: `JIT · ${ws.phase}`, compact: `JIT · ${ws.phase}`, pips: [] };
  return { kind: "none", text: "", compact: "", pips: [] };
}

/** ui-spec § Actions → Primary action, in that order. */
function primary(
  ws: DisplayInput,
  lifecycle: Lifecycle | null,
  where: string,
): WorkspaceDisplay["primary"] {
  const cont = { action: "continue", label: `↗ Continue in ${where}`, destructive: false } as const;
  if (ws.paused) return { action: "resume", label: "▶ Resume", destructive: false };
  // The session is what answers; a gate or PR item alone doesn't make Continue the next step.
  const asked = ws.workspaceState?.needs.some((n) => n.source === "session" || n.source === "text");
  if (asked) return cont;
  if (lifecycle === "shipped")
    return { action: "close-out", label: "✓ Close out", destructive: true };
  if (ws.state === "down" || ws.state === "stopped")
    return { action: "up", label: "▶ Up", destructive: false };
  return cont;
}

const ACTIVITY_TONE: Record<string, Tone> = {
  gone: "err",
  queued: "warn",
  starting: "warn",
};

// Core's SESSION_GONE_MS: silent this long, a Thinking is kept live only by its open process.
const QUIET_MS = 30 * 60_000;

/** The chip's detail (SW-953): null when it would only restate the chip, dim once the session went quiet. */
function activity(a: WorkspaceState["activity"], now: Date): WorkspaceDisplay["activity"] {
  if (a.id === "idle" || a.id === "paused") return null;
  const quiet =
    a.id === "thinking" && a.since !== null && now.getTime() - Date.parse(a.since) >= QUIET_MS;
  if (quiet) return { text: a.label, tone: "off", time: `last heard ${ago(a.since, now)}` };
  return { text: a.label, tone: ACTIVITY_TONE[a.id] ?? "ok", time: ago(a.since, now) };
}

function needRows(ws: DisplayInput, opts: DisplayOptions, now: Date): NeedRow[] {
  if (ws.paused) return [];
  return [...(ws.workspaceState?.needs ?? []), ...(opts.prNeeds ?? [])].map((n) => ({
    id: n.id,
    what: n.what,
    action: n.action,
    since: ago(n.since, now),
    guess: n.source === "text",
    url: n.url ?? null,
    dismiss: n.dismiss ?? null,
  }));
}

export function displayModel(ws: DisplayInput, opts: DisplayOptions = {}): WorkspaceDisplay {
  const now = opts.now ?? new Date();
  const lifecycle = opts.lifecycle ?? null;
  const st = ws.workspaceState;
  const a = ws.paused ? PAUSED : AGENT[(st?.agent ?? NO_AGENT).id];
  const needsList = needRows(ws, opts, now);
  const needs = !ws.paused && (st?.agent?.id === "needs-you" || needsList.length > 0);
  const withPr = (opts.prs ?? []).filter((p): p is PrInput & { url: string } => p.url !== null);
  return {
    agent: {
      ...a,
      label: a.glyph ? `${a.glyph} ${a.word}` : a.word,
      time: ws.paused ? `paused ${ago(ws.paused.at, now)}` : agentTime(ws, now),
    },
    needs,
    question: needs ? (needsList[0]?.what ?? null) : null,
    needsList,
    phase: st
      ? {
          text: [st.phase.label, st.phase.id === "pr-open" ? opts.phaseDetail : null]
            .filter(Boolean)
            .join(" · "),
          tone: "off",
        }
      : null,
    activity: st ? activity(st.activity, now) : null,
    autonomous: ws.autonomous ? { full: "⚙ Autonomous", compact: "⚙ Auto" } : null,
    model: ws.model ?? null,
    containers: containers(ws),
    services: ws.services.map(({ name, state }) => {
      const s = ws.crashLoops?.some((l) => l.service === name) ? CRASH_LOOP : SERVICE[state];
      return {
        name,
        glyph: s.glyph,
        tone: s.tone,
        codicon: s.codicon,
        text: `${s.glyph} ${name}${s.word}`,
      };
    }),
    usage: usage(opts.usage),
    started: ws.started
      ? { text: `started ${ago(ws.started.at, now)} by ${ws.started.by}`, tone: "off" }
      : null,
    crash: crash(ws),
    prsEmpty:
      opts.prs === null
        ? { text: "PRs unavailable", tone: "warn" }
        : withPr.length
          ? null
          : { text: "None yet", tone: "off" },
    prs: withPr.map((p) => ({ ref: prRef(p.url), url: p.url, state: prState(p), ci: ci(p) })),
    workflow: workflow(ws, lifecycle),
    primary: primary(ws, lifecycle, opts.where ?? "Terminal"),
  };
}
