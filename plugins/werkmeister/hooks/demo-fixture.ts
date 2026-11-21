// SW-623: the three demo workspaces of scripts/docs-demo-home.sh as the pane's node child answers them,
// keyed by op, for the headless render (scripts/render-pane.mjs) and its register.test.ts check.
// Fixed times, not core's live output: core reads Docker and host load, so every render would differ.

export const DEMO_NOW = "2026-11-10T12:00:00Z";

const before = (min: number) => new Date(Date.parse(DEMO_NOW) - min * 60_000).toISOString();

const ws = (
  name: string,
  issue: string,
  workType: string,
  task: string,
  stage: { index: number; total: number; name: string } | null,
  lifecycle: unknown = null,
) => ({
  name,
  path: `/features/${name}`,
  issueId: issue,
  issueUrl: `https://example.atlassian.net/browse/${issue}`,
  labels: ["focus"],
  task,
  description: null,
  workType,
  feature: name,
  stage,
  lifecycle,
  sessionTitle: null,
  sessionOrigin: null,
});

const status = (
  name: string,
  agent: "working" | "needs-you" | "done",
  activity: { id: string; label: string; since: string | null },
  needs: unknown[] = [],
) => ({
  name,
  state: "down",
  running: 0,
  total: 0,
  services: [],
  phase: null,
  autonomous: false,
  lastActivity: null,
  workspaceState: {
    phase: { id: "building", label: "Building", stage: null },
    activity: { ...activity, session: null },
    needs,
    agent: { id: agent, since: activity.since },
  },
});

export const DEMO: Record<string, unknown> = {
  "list-workspaces": {
    root: "/features",
    workspaces: [
      ws(
        "demo-12-checkout-retry",
        "DEMO-12",
        "feature",
        "Retry a checkout that fails on a card decline",
        {
          index: 3,
          total: 4,
          name: "implement",
        },
      ),
      ws("demo-15-search-facets", "DEMO-15", "feature", "Add facets to the search results page", {
        index: 2,
        total: 4,
        name: "spec",
      }),
      ws("demo-19-login-copy", "DEMO-19", "bugfix", "Fix the login error copy", null, {
        state: "merged",
        prs: [
          {
            dir: "demo-app",
            status: "merged",
            url: "https://github.com/example/demo-app/pull/19",
          },
        ],
      }),
    ],
  },
  "workspace-status": {
    statuses: [
      status("demo-12-checkout-retry", "working", {
        id: "thinking",
        label: "Thinking",
        since: before(12),
      }),
      status("demo-15-search-facets", "needs-you", { id: "idle", label: "Idle", since: null }, [
        {
          id: "question:demo",
          kind: "question",
          what: "Should the facet panel collapse on phone widths?",
          since: before(14 * 60),
          action: "Answer it",
          source: "session",
        },
      ]),
      status("demo-19-login-copy", "done", { id: "idle", label: "Idle", since: null }),
    ],
    infra: { state: "up", running: 1, total: 1, services: [] },
  },
  "workspace-prs": [],
  "workspace-resources": {
    projects: {},
    host: { load: [2.4, 2.1, 1.9], cores: 12, featureCpuPercent: 0 },
  },
  "tracker-auth": { ok: true, fix: "" },
  intercepts: { available: false, connected_namespace: null, intercepts: [], remote_services: [] },
};
