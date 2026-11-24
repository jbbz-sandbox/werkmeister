// SW-1088: WorkspaceList mounted in a DOM against a fake bridge, so the dashboard's Needs you count
// and filter break here if they stop using the strip's rule or refreshPrs drops the PR poll's needs.
// Run: npm run build && node --test test/workspace-list.test.mjs
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { Window } from "happy-dom";

// workspace-ui.js imports tokens.css, which node can't load: an empty module stands in.
register(
  `data:text/javascript,${encodeURIComponent(
    `export async function load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    }`,
  )}`,
);

const window = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "MouseEvent"])
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? window : window[k],
    configurable: true,
  });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceList } = await import("../dist/workspace-ui.js");

const need = (over = {}) => ({
  id: "question:s",
  kind: "question",
  what: "Which fix?",
  since: null,
  action: "Answer it",
  source: "session",
  ...over,
});
const status = (name, over = {}) => ({
  name,
  state: "up",
  running: 1,
  total: 1,
  services: [{ name: "api", state: "healthy" }],
  claude: { state: null },
  workspaceState: {
    phase: { id: "building", label: "Building", stage: null },
    activity: { id: "idle", label: "Idle", since: null, session: null },
    needs: [],
    agent: { id: "idle", since: null },
  },
  stage: null,
  phase: null,
  autonomous: false,
  lastActivity: null,
  ...over,
});
const asking = { agent: { id: "needs-you", since: null }, needs: [need()] };
const workspaces = ["paused-asks", "pr-asks", "quiet"].map((name) => ({
  name,
  path: `/ws/${name}`,
  issueId: null,
  issueUrl: null,
  labels: [],
}));
const tools = {
  "list-workspaces": { root: "/ws", workspaces },
  status: {
    statuses: [
      status("paused-asks", {
        paused: { at: new Date().toISOString(), containers: [] },
        workspaceState: { ...status("x").workspaceState, ...asking },
      }),
      status("pr-asks"),
      status("quiet"),
    ],
  },
  "workspace-prs": {
    workspaces: [
      {
        name: "pr-asks",
        repos: [],
        needs: [
          need({
            id: "ci-failed:werkmeister",
            kind: "ci-failed",
            what: "CI failed on werkmeister (1 failing)",
            source: "pr",
          }),
        ],
      },
    ],
  },
};
const bridge = { callTool: async (name) => tools[name] ?? {}, openLink: () => undefined };

test("WorkspaceList: the Needs you count and filter leave out a paused ask and take in a PR-only need", async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(h(WorkspaceList, { bridge, headerRoot: null, reloadRef: { current: () => {} } }));
  });
  const button = [...el.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Needs you"),
  );
  assert.equal(button.textContent, "● Needs you · 1");
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  const cards = [...el.querySelectorAll("article")];
  assert.equal(cards.length, 1);
  assert.match(cards[0].textContent, /pr-asks/);
  assert.match(
    cards[0].textContent,
    /CI failed on werkmeister \(1 failing\)/,
    "its card names the need",
  );
  await act(async () => root.unmount());
});
