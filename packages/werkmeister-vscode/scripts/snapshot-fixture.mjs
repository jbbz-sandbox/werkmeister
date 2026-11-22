// Quiet and busy rows for the Workspaces view, shaped as the daemon's `status` and `resources` tools
// answer: the render snapshots draw them (SW-1019) and the fixture dev host serves them (SW-1020).
const NOW = new Date("2026-11-22T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60_000).toISOString();
const LABEL = {
  idle: "Idle",
  testing: "Running tests",
  tool: "Running a tool",
  thinking: "Thinking",
  queued: "Waiting for capacity",
};

const status = (name, { agent = "idle", activity = "idle", question = null, ...over } = {}) => ({
  name,
  project: `werkmeister-${name}`,
  state: "down",
  running: 0,
  total: 0,
  slot: null,
  ports: null,
  services: [],
  claude: { state: null },
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
  workspaceState: {
    phase: { id: "building", label: "Building", stage: null },
    activity: { id: activity, label: LABEL[activity], since: ago(3), session: null },
    needs: question
      ? [
          {
            id: "question:s",
            kind: "question",
            what: question,
            since: ago(25),
            action: "Answer it",
            source: "session",
          },
        ]
      : [],
    agent: { id: agent, since: question ? ago(25) : null },
  },
  ...over,
});

const up = (running, total = running) => ({
  state: running === total ? "up" : "partial",
  running,
  total,
});
const pr = (n, over = {}) => ({
  url: `https://github.com/o/werkmeister/pull/${n}`,
  state: "OPEN",
  ci: "pass",
  failingChecks: 0,
  mergeable: "MERGEABLE",
  ...over,
});

const QUIET = {
  statuses: [
    status("sw-101-login", { ...up(2), agent: "working", activity: "testing" }),
    status("sw-102-docs"),
  ],
  infra: {
    state: "up",
    running: 2,
    total: 2,
    services: [
      { name: "caddy", state: "healthy" },
      { name: "registry", state: "healthy" },
    ],
  },
  prs: {},
  host: { load: [1.2, 1.1, 0.9], cores: 10, featureCpuPercent: 30 },
};

const BUSY = {
  statuses: [
    status("sw-201-checkout-flow-rewrite", {
      ...up(4),
      agent: "needs-you",
      question: "Ship the migration now or after the release?",
    }),
    status("sw-202-search", { ...up(1, 3), agent: "needs-you", question: "Which port?" }),
    status("sw-203-billing", { ...up(2), agent: "needs-you", question: "Keep the old webhook?" }),
    status("sw-204-mobile-auth", { ...up(3), agent: "working", activity: "testing" }),
    status("sw-205-notifications", { ...up(2), agent: "working", activity: "tool" }),
    status("sw-206-reports", { ...up(2), agent: "working", activity: "thinking" }),
    status("sw-207-queue-a", { agent: "working", activity: "queued" }),
    status("sw-208-queue-b", { agent: "working", activity: "queued" }),
    status("sw-209-shipped", { agent: "done" }),
  ],
  infra: {
    state: "partial",
    running: 2,
    total: 4,
    services: [
      { name: "caddy", state: "down" },
      { name: "registry", state: "healthy" },
      { name: "k8s-forwards", state: "starting" },
      { name: "jaeger", state: "running" },
    ],
  },
  prs: {
    "sw-201-checkout-flow-rewrite": [pr(301, { ci: "fail", failingChecks: 3 })],
    "sw-204-mobile-auth": [pr(302, { mergeable: "CONFLICTING" }), pr(303, { state: "MERGED" })],
    "sw-205-notifications": [pr(304, { ci: "pending" })],
  },
  host: { load: [14.5, 12.1, 9.8], cores: 10, featureCpuPercent: 85 },
};

/** `quiet` or `busy`: the `status` reply (statuses, infra), PR inputs by workspace, the host and the clock. */
export function snapshot(kind) {
  const s = { quiet: QUIET, busy: BUSY }[kind];
  if (!s) throw new Error(`no snapshot "${kind}": quiet or busy`);
  return { ...s, now: NOW };
}
