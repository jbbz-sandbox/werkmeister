/**
 * Workspace data → the words, tones and glyphs every surface shows (SW-49). No
 * DOM and no runtime imports, so the pane (Claude Code's `Box`/`Text`) and the
 * VS Code tree read the same labels as the React card. Wording follows
 * `docs/ui-spec.md` § The card; where `docs/design/workspace-card` differs, the
 * spec wins. Tones are names: each surface maps them to its own colours.
 */

import type {
  ClaudeSessionSignal,
  IcmStage,
  Lifecycle,
  RepoPr,
  WorkspaceStatus,
} from "werkmeister-core";

/** `needs` is the solid-amber chip, used only for Needs you. */
export type Tone = "ok" | "warn" | "err" | "off" | "pr" | "needs";

export type AgentState = ClaudeSessionSignal["agent"];
export type ServiceHealth = WorkspaceStatus["services"][number]["state"];

/** The fields read from a `WorkspaceStatus`; a full one satisfies it. */
export interface DisplayInput {
  state: WorkspaceStatus["state"];
  running: number;
  total: number;
  services: { name: string; state: ServiceHealth }[];
  claude: Pick<ClaudeSessionSignal, "agent" | "at" | "question">;
  stage: IcmStage | null;
  phase: string | null;
  autonomous: boolean;
  lastActivity: string | null;
  /** SW-41; optional so a core older than it still renders. */
  started?: { at: string; by: string } | null;
  crashLoops?: { service: string; restarts: number; lastLog: string | null }[];
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
  autonomous: { full: string; compact: string } | null;
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
  primary: { action: "continue" | "close-out" | "up"; label: string; destructive: boolean };
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

function agentTime(ws: DisplayInput, now: Date): string {
  const { agent, at } = ws.claude;
  if (agent === "needs-you") return `asked a question ${ago(at, now)}`.trim();
  if (agent === "working") return `last activity ${ago(ws.lastActivity ?? at, now)}`.trim();
  if (agent === "done") return `idle since ${ago(at ?? ws.lastActivity, now)}`.trim();
  return "no live turn, nothing asked";
}

function containers(ws: DisplayInput): Text {
  const loops = ws.crashLoops ?? [];
  if (loops.length === 1) return { text: `${loops[0].service} crash-looping`, tone: "err" };
  if (loops.length > 1) return { text: `${loops.length} crash-looping`, tone: "err" };
  const count = `${ws.running} of ${ws.total} up`;
  if (ws.state === "up") return { text: count, tone: "ok" };
  if (ws.state === "partial") return { text: count, tone: "warn" };
  if (ws.state === "stopped") return { text: count, tone: "off" };
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

/** The pane's host line: `host load 3.2 · 2.8 · 2.1 / 10 cores · features 45% CPU`. */
export function hostLine(h: HostInput | null): Text {
  if (!h) return { text: "host load n/a", tone: "off" };
  return {
    text: `host load ${h.load.join(" · ")} / ${h.cores} cores · features ${h.featureCpuPercent}% CPU`,
    tone: h.load[0] > h.cores ? "warn" : "ok",
  };
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
  if (ws.claude.agent === "needs-you") return cont;
  if (lifecycle === "shipped")
    return { action: "close-out", label: "✓ Close out", destructive: true };
  if (ws.state === "down" || ws.state === "stopped")
    return { action: "up", label: "▶ Up", destructive: false };
  return cont;
}

export function displayModel(ws: DisplayInput, opts: DisplayOptions = {}): WorkspaceDisplay {
  const now = opts.now ?? new Date();
  const lifecycle = opts.lifecycle ?? null;
  const a = AGENT[ws.claude.agent];
  const needs = ws.claude.agent === "needs-you";
  const withPr = (opts.prs ?? []).filter((p): p is PrInput & { url: string } => p.url !== null);
  return {
    agent: {
      ...a,
      label: a.glyph ? `${a.glyph} ${a.word}` : a.word,
      time: agentTime(ws, now),
    },
    needs,
    question: needs ? ws.claude.question : null,
    autonomous: ws.autonomous ? { full: "⚙ Autonomous", compact: "⚙ Auto" } : null,
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
