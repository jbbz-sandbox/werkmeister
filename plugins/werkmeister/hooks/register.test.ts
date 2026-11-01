import type { On } from "claude-code";
import type { Engine, Plugin } from "claude-code/testing";
import { expect, mock, test } from "claude-code/testing";
import type { FormField, WorkspaceRow } from "../types";
import {
  actionsFor,
  applyFormFields,
  buildRows,
  display,
  formFields,
  interceptControl,
  metaParts,
  optionGroups,
  resourcesLine,
  withLivePrs,
} from "./register";
import { edit } from "./textarea";

const SURFACES = ["terminal", "desktop"] as const;
const WS = "plugin:werkmeister:workspaces";
const PANE_PROPS = {
  title: "Werkmeister workspaces",
  isFocused: false,
  bodyColumns: 100,
  placement: "dock" as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
};

type McpAnswer = {
  content: { type: "text"; text: string }[];
  isError: boolean;
  structuredContent?: unknown;
};
/** *value*, or a failed test naming what was missing (in place of a `!` assertion). */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error(`expected a value, got ${value}`);
  return value;
}

type McpStub = Record<string, (args: Record<string, unknown>) => McpAnswer | Promise<McpAnswer>>;

/** Stubs every noun the module calls. `calls` records each mcp.call as `server/tool`. */
function world(on: On, stubs: McpStub = {}) {
  const calls: { key: string; args: Record<string, unknown>; via: "mcp" | "process" }[] = [];
  const toasts: string[] = [];
  const clock = mock.clock(on);
  on("ui.open", () => ({ value: { isPlaced: true as const } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  // The workspace server's tools run in a node child (the auto-mode gate refuses a plugin's own MCP call):
  // the request rides on stdin as { op, ...args }; the same `stubs` map answers by `${WS}/${op}`.
  on("process.run", async (_$, e) => {
    const { op, ...args } = JSON.parse(e.init?.stdin ?? "{}") as { op: string } & Record<
      string,
      unknown
    >;
    const key = `${WS}/${op}`;
    calls.push({ key, args, via: "process" });
    const stub = stubs[key];
    const a = stub
      ? await stub(args)
      : { content: [{ type: "text" as const, text: `no stub for ${key}` }], isError: true };
    const line = a.isError
      ? { ok: false, error: a.content[0]?.text }
      : { ok: true, result: a.structuredContent };
    return {
      value: {
        exitCode: 0,
        stdout: JSON.stringify(line) + "\n",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
  on("ui.log", () => ({ value: undefined }));
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined };
  });
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("tool.register", (_$, e) => ({ value: { tool: `mcp__werkmeister__${e.name}` } }));
  on("mcp.call", async (_$, e) => {
    const key = `${e.server}/${e.tool}`;
    calls.push({ key, args: e.args, via: "mcp" });
    const stub = stubs[key];
    if (!stub)
      return {
        value: { content: [{ type: "text" as const, text: `no stub for ${key}` }], isError: true },
      };
    return { value: await stub(e.args) };
  });
  return { calls, toasts, clock };
}

function ok(structuredContent: unknown, text = "ok"): McpAnswer {
  return { content: [{ type: "text", text }], isError: false, structuredContent };
}

type Mounted = Pick<Awaited<ReturnType<Engine["ui"]["mount"]>>, "find" | "press">;

/** A card button, in whichever group row it draws. */
async function seek(ui: Mounted, key: string) {
  return ui.find({ key });
}

/** Presses a card button: a group row's or the confirm's. */
async function tap(ui: Mounted, key: string) {
  await ui.press({ key });
}

async function openPane($: Engine) {
  await $.command.run({
    command: "workspaces",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  });
}

test("empty list draws the empty message", async ($, on) => {
  world(on, {
    [`${WS}/list-workspaces`]: () => ok({ root: "/ws", workspaces: [] }),
    [`${WS}/workspace-status`]: () =>
      ok({ statuses: [], infra: { state: "down", running: 0, total: 0, services: [] } }),
    "ccd_session_mgmt/list_sessions": () => ok(undefined, "[]"),
  });
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ text: /No workspaces/ }))?.text).toMatch(/No workspaces/);
    await ui.unmount();
  }
});

const LIST = {
  root: "/ws",
  workspaces: [
    {
      name: "ab",
      path: "/ws/ab",
      issueId: "PROJ-1",
      issueUrl: "https://x.atlassian.net/browse/PROJ-1",
      labels: [],
      task: "BWell",
      description: "BWell technologies",
      workType: "spike",
      stage: { index: 5, total: 6, name: "implement" },
      sessionTitle: "Demo project",
      sessionOrigin: "sdk-cli",
    },
    {
      name: "abc",
      path: "/ws/abc",
      issueId: null,
      issueUrl: null,
      labels: [],
      task: null,
      description: null,
      workType: "bugfix",
      stage: null,
      sessionTitle: null,
      sessionOrigin: null,
    },
    {
      name: "empty",
      path: "/ws/empty",
      issueId: null,
      issueUrl: null,
      labels: [],
      task: null,
      description: null,
      workType: null,
      stage: null,
      sessionTitle: null,
      sessionOrigin: null,
    },
  ],
};
const STATUS = {
  infra: { state: "up", running: 1, total: 1, services: [] },
  statuses: [
    {
      name: "ab",
      project: "sandbox-ab",
      state: "up",
      running: 3,
      total: 3,
      slot: 1,
      ports: null,
      services: [],
      claude: { state: "idle", agent: "working" },
    },
    {
      name: "abc",
      project: "sandbox-abc",
      state: "partial",
      running: 1,
      total: 3,
      slot: 2,
      ports: null,
      services: [],
      claude: { state: "idle", agent: "needs-you" },
    },
    {
      name: "empty",
      project: null,
      state: "down",
      running: 0,
      total: 0,
      slot: null,
      ports: null,
      services: [],
      claude: { state: "idle", agent: "idle" },
    },
  ],
};
const SESSIONS = [
  {
    sessionId: "local_1",
    title: "Newer in abc",
    cwd: "/ws/abc/repo",
    link: "claude://x/local_1",
    lastActivityAt: "2026-10-09T02:00:00Z",
  },
  {
    sessionId: "local_2",
    title: "Older in abc",
    cwd: "/ws/abc",
    link: "claude://x/local_2",
    lastActivityAt: "2026-10-09T01:00:00Z",
  },
  {
    sessionId: "local_3",
    title: "Elsewhere",
    cwd: "/home/x",
    link: "claude://x/local_3",
    lastActivityAt: "2026-10-09T00:00:00Z",
  },
];

const PRS = [
  {
    name: "ab",
    repos: [
      {
        repo: "sandbox",
        branch: "u/ab",
        url: "https://github.com/o/sandbox/pull/12",
        state: "OPEN",
        title: "Fix",
        labels: [],
      },
      {
        repo: "api",
        branch: "u/ab",
        url: "https://github.com/o/api/pull/7",
        state: "MERGED",
        title: "Api",
        labels: [],
      },
      { repo: "web", branch: "u/ab", url: null, state: null, title: null, labels: [] },
    ],
  },
  {
    name: "abc",
    repos: [{ repo: "sandbox", branch: "main", url: null, state: null, title: null, labels: [] }],
  },
];

function stubs(over: Partial<McpStub> = {}): McpStub {
  return {
    [`${WS}/list-workspaces`]: () => ok(LIST),
    [`${WS}/workspace-status`]: () => ok(STATUS),
    "ccd_session_mgmt/list_sessions": () => ok(undefined, JSON.stringify(SESSIONS)),
    [`${WS}/workspace-prs`]: () => ok(PRS),
    [`${WS}/tracker-auth`]: () => ok({ ok: true, fix: "" }),
    [`${WS}/workspace-resources`]: () => ok(RESOURCES),
    ...over,
  };
}

const RESOURCES = {
  projects: { "sandbox-ab": { cpuPercent: 12.3, memMib: 410 } },
  host: { load: [3.2, 2.8, 2.1], cores: 10, featureCpuPercent: 45 },
};

test("workspace data comes from the node child, not an MCP call", async ($, on) => {
  const w = world(on, stubs());
  await openPane($);
  expect(w.calls.filter((c) => c.via === "mcp" && c.key.startsWith(WS))).toHaveLength(0);
  expect(
    w.calls
      .filter((c) => c.via === "process")
      .map((c) => c.key)
      .sort(),
  ).toEqual([
    `${WS}/intercepts`,
    `${WS}/list-workspaces`,
    `${WS}/tracker-auth`,
    `${WS}/workspace-prs`,
    `${WS}/workspace-resources`,
    `${WS}/workspace-status`,
  ]);
});

test("buildRows: the card's agent state is core's, with its time and question (SW-46)", () => {
  const ws = (name: string) => ({ name, path: `/ws/${name}` }) as WorkspaceRow;
  const st = (name: string, agent: string) => ({
    name,
    state: "up" as const,
    running: 1,
    total: 1,
    services: [],
    claude: { state: "idle", agent: agent as "idle", at: "2026-10-20T11:48:00Z", question: "Q?" },
    phase: "implement",
    autonomous: true,
    lastActivity: null,
  });
  const names = ["w", "n", "d", "i", "none"];
  const rows = buildRows(
    { workspaces: names.map(ws) },
    {
      statuses: [st("w", "working"), st("n", "needs-you"), st("d", "done"), st("i", "idle")],
    },
    [],
  );
  expect(rows.map((r) => r.claude.agent)).toEqual(["working", "needs-you", "done", "idle", "idle"]);
  expect(rows[1]?.claude).toEqual({
    agent: "needs-you",
    at: "2026-10-20T11:48:00Z",
    question: "Q?",
  });
  expect([rows[0]?.phase, rows[0]?.autonomous]).toEqual(["implement", true]);
  // A workspace core reported nothing for reads idle, not working.
  expect([rows[4]?.claude.question, rows[4]?.phase, rows[4]?.autonomous]).toEqual([
    null,
    null,
    false,
  ]);
});

test("a card is name and agent chip, work type · task, then the labelled compact line (SW-52)", async ($, on) => {
  const w = world(on, stubs());
  await openPane($);
  await w.clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
    expect((await ui.find({ key: "claude:ab" }))?.text).toBe("◌ Working");
    expect((await ui.find({ key: "claude:abc" }))?.text).toBe("● Needs you");
    expect((await ui.find({ key: "claude:empty" }))?.text).toBe("Idle");
    expect(await ui.find({ key: "auto:ab" })).toBeUndefined();
    // The subtitle is workspace.yml's work type and task, never the session title or the description.
    expect((await ui.find({ key: "task:ab" }))?.text).toBe("Spike · BWell");
    expect((await ui.find({ key: "task:abc" }))?.text).toBe("Bug");
    expect(await ui.find({ key: "task:empty" })).toBeUndefined();
    expect(await ui.find({ text: /Demo project|BWell technologies/ })).toBeUndefined();
    expect(await ui.find({ key: "session:abc" })).toBeUndefined();
    // Every count names its unit; one fixed order: containers · PRs · workflow.
    expect((await ui.find({ key: "meta:ab" }))?.text).toBe(
      "containers 3 of 3 up · PRs sandbox#12 Open, api#7 Merged · stage 5/6 implement",
    );
    expect((await ui.find({ key: "meta:abc" }))?.text).toBe("containers 1 of 3 up · PRs None yet");
    expect((await ui.find({ key: "meta:empty" }))?.text).toBe("containers down · PRs None yet");
    await ui.unmount();
  }
});

test("cards link each PR and, in the work row, the issue", async ($, on) => {
  const w = world(on, stubs());
  await openPane($);
  await w.clock.settle();
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect(await ui.find({ type: "Link", text: "sandbox#12" })).toBeDefined();
    expect(await ui.find({ type: "Link", text: "api#7" })).toBeDefined();
    expect((await ui.find({ key: "meta:ab" }))?.text).not.toMatch(/web/);
    expect((await seek(ui, "issue:ab"))?.text).toBe("Open issue ↗");
    expect(await seek(ui, "issue:abc")).toBeUndefined();
    await ui.unmount();
  }
});

test("the Focused only toggle shows only workspaces labelled focus", async ($, on) => {
  const list = {
    ...LIST,
    workspaces: LIST.workspaces.map((w) => (w.name === "abc" ? { ...w, labels: ["focus"] } : w)),
  };
  world(on, stubs({ [`${WS}/list-workspaces`]: () => ok(list) }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "terminal",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "row:abc" }))?.text).toBe("abc");
  expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
  expect((await ui.find({ key: "focus" }))?.text).toBe("☐ Focused only");
  await ui.press({ key: "focus" });
  expect((await ui.find({ key: "focus" }))?.text).toBe("☑ Focused only");
  expect(await ui.find({ key: "row:ab" })).toBeUndefined();
  expect((await ui.find({ key: "row:abc" }))?.text).toBe("abc");
  await ui.press({ key: "focus" });
  expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
  await ui.unmount();
});

test("PRs read loading… until the first poll ends, and PRs unavailable · retry when it failed", async ($, on) => {
  let fail = false;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-prs`]: async () => {
        await gate;
        return fail ? { content: [{ type: "text", text: "gh down" }], isError: true } : ok(PRS);
      },
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "meta:abc" }))?.text).toBe("containers 1 of 3 up · PRs loading…");
  fail = true;
  release();
  await w.clock.settle();
  expect((await ui.find({ key: "meta:abc" }))?.text).toBe(
    "containers 1 of 3 up · PRs unavailable · retry",
  );
  await ui.unmount();
});

test("segment-aware join picks the deepest workspace and the newest session", () => {
  // The fixtures leave out list fields this join never reads.
  const rows = buildRows(LIST as never, STATUS as never, SESSIONS);
  expect(rows.map((r) => r.session?.id ?? null)).toEqual([null, "local_1", null]);
});

test("sessions from text block with no structuredContent still join", async ($, on) => {
  world(
    on,
    stubs({
      "ccd_session_mgmt/list_sessions": () => ({
        content: [{ type: "text", text: JSON.stringify(SESSIONS) }],
        isError: false,
      }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await seek(ui, "continue:abc"))?.text).toBe("⇆ Open beside");
  await ui.unmount();
});

test("a failed session lookup keeps the workspace list", async ($, on) => {
  world(
    on,
    stubs({
      "ccd_session_mgmt/list_sessions": () => ({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "row:ab" })).toBeDefined();
  // abc's only session was the desktop one: with nothing to continue, New session takes the primary slot.
  expect(await seek(ui, "continue:abc")).toBeUndefined();
  expect((await ui.find({ key: "new:abc" }))?.props.variant).toBe("primary");
  await ui.unmount();
});

test("only a Needs you card has the amber border; the ? toggle shows the legend", async ($, on) => {
  world(on, stubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "ws:abc" }))?.props).toMatchObject({
    borderColor: "warning",
    borderStyle: "bold",
  });
  for (const name of ["ab", "empty"])
    expect((await ui.find({ key: `ws:${name}` }))?.props).toMatchObject({
      borderColor: "inactive",
      borderDimColor: true,
      borderStyle: "round",
    });
  expect((await ui.find({ key: "tab:list" }))?.props.label).toBe("Workspaces · 1 needs you");
  expect(await ui.find({ key: "legend-box" })).toBeUndefined();
  await ui.press({ key: "legend" });
  expect((await ui.find({ key: "legend-box" }))?.text).toMatch(
    /● Needs you +agent asked you something; amber border = this, only this/,
  );
  await ui.press({ key: "legend" });
  expect(await ui.find({ key: "legend-box" })).toBeUndefined();
  await ui.unmount();
});

test("Continue with no desktop session is labelled Terminal and resumes there", async ($, on) => {
  const w = world(
    on,
    stubs({ [`${WS}/claude-resume`]: () => ok({ path: "/ws/ab", sessionId: "s1" }) }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await seek(ui, "continue:ab"))?.text).toBe("↗ Continue in Terminal");
  await tap(ui, "continue:ab");
  expect(w.calls.find((c) => c.key === `${WS}/claude-resume`)?.args).toEqual({ name: "ab" });
  expect(w.calls.find((c) => c.key === "ccd_window/open_session_in")).toBeUndefined();
  await ui.unmount();
});

test("Continue on a VS Code session is labelled VS Code and opens the folder there", async ($, on) => {
  const vscode = {
    ...LIST,
    workspaces: LIST.workspaces.map((w) =>
      w.name === "ab" ? { ...w, sessionOrigin: "claude-vscode" } : w,
    ),
  };
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () => ok(vscode),
      [`${WS}/open-vscode`]: () => ok({ path: "/ws/ab" }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await seek(ui, "continue:ab"))?.text).toBe("↗ Continue in VS Code");
  await tap(ui, "continue:ab");
  expect(w.calls.find((c) => c.key === `${WS}/open-vscode`)?.args).toEqual({ path: "/ws/ab" });
  expect(w.calls.find((c) => c.key === `${WS}/claude-resume`)).toBeUndefined();
  expect(w.toasts).toEqual(["Opening ab in VS Code"]);
  await ui.unmount();
});

test("every workspace has New session, the one this session sits in too", async ($, on) => {
  world(on, stubs());
  on("session.cwd", () => ({ value: "/ws/abc/repo" }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  for (const name of ["ab", "abc", "empty"])
    expect((await seek(ui, `new:${name}`))?.text).toBe("＋ New session");
  await ui.unmount();
});

test("a failed list keeps the last rows and shows the error", async ($, on) => {
  let fail = false;
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () =>
        fail ? { content: [{ type: "text", text: "docker down" }], isError: true } : ok(LIST),
    }),
  );
  await openPane($);
  fail = true;
  await w.clock.advance(5000);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "row:ab" })).toBeDefined();
  expect((await ui.find({ key: "error" }))?.text).toBe("docker down");
  await ui.unmount();
});

test("the card draws session, containers and work rows, the primary highlighted, no ⋯", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "continue:ab" }))?.props.variant).toBe("primary");
    expect((await ui.find({ key: "stop:ab" }))?.props.variant).toBe("secondary");
    expect((await ui.find({ key: "session-row:ab" }))?.text).toBe(
      "session↗ Continue in Terminal＋ New session",
    );
    expect((await ui.find({ key: "containers-row:ab" }))?.text).toBe(
      "containers■ Stop⏸ Pause↻ Restart⏻ DownLogsOpen feature ↗",
    );
    expect((await ui.find({ key: "work-row:ab" }))?.text).toBe(
      "work↻ Refresh PRsOpen issue ↗✓ Close out✕ Abandon…",
    );
    expect(await ui.find({ key: "more:ab" })).toBeUndefined();
    // Nothing up and nothing to continue: Up leads, New session beside it.
    expect((await ui.find({ key: "up:empty" }))?.props.variant).toBe("primary");
    expect(await ui.find({ key: "new:empty" })).toBeDefined();
    for (const n of ["ab", "abc", "empty"])
      expect(await ui.find({ key: `remove:${n}` })).toBeUndefined();
    await ui.unmount();
  }
});

/** The design's sample workspaces (docs/design/workspace-card/design/data.js) as pane rows. */
function sample(over: Partial<WorkspaceRow>): WorkspaceRow {
  return {
    name: "s",
    path: "/ws/s",
    issueId: "jbbz-stellwerk/stellwerk#1",
    issueUrl: "https://github.com/jbbz-stellwerk/stellwerk/issues/1",
    labels: [],
    task: null,
    description: null,
    workType: "feature",
    feature: "s",
    stage: null,
    lifecycle: null,
    sessionTitle: "t",
    sessionOrigin: "sdk-cli",
    state: "up",
    running: 2,
    total: 2,
    services: [],
    claude: { agent: "working", at: null, question: null },
    phase: null,
    autonomous: false,
    lastActivity: null,
    project: "sandbox-s",
    started: null,
    crashLoops: [],
    paused: null,
    resumeNudge: false,
    session: null,
    ...over,
  };
}
const DESKTOP = { id: "local_9", title: "t", link: null, pinned: false };

test("actionsFor and metaParts give the five Pane View samples their design buttons and line", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const card = (r: WorkspaceRow, prs: Parameters<typeof display>[1] = []) => {
    const d = display(r, prs, NOW);
    const a = actionsFor(r, d, true);
    return {
      chip: d.agent.label,
      line: metaParts(d, true)
        .map((p) => p.text)
        .join(""),
      primary: a.primary,
      session: a.session,
      containers: a.containers,
      work: a.work,
    };
  };
  const PR = (
    n: number,
    state: "OPEN" | "MERGED",
    ci: "pass" | "running" | "fail",
    failingChecks = 0,
  ) => ({
    repo: "stellwerk",
    url: `https://github.com/jbbz-stellwerk/stellwerk/pull/${n}`,
    state,
    title: "t",
    ci,
    failingChecks,
  });
  // 143: needs you, containers down, a Desktop session.
  expect(
    card(
      sample({
        state: "down",
        running: 0,
        services: [
          { name: "cli", state: "down" },
          { name: "stellwerk-dashboard", state: "down" },
        ],
        stage: { index: 2, total: 4, name: "findings" },
        claude: { agent: "needs-you", at: "2026-10-20T11:48:00Z", question: "Q?" },
        session: DESKTOP,
      }),
    ),
  ).toEqual({
    chip: "● Needs you",
    line: "containers down · PRs None yet · stage 2/4 findings",
    primary: "continue",
    session: ["continue", "new", "pin"],
    containers: ["up"],
    work: ["prs", "issue", "abandon"],
  });
  // 206: working, autonomous, both up, a draft-or-open PR with CI running, a Terminal session.
  expect(
    card(sample({ stage: { index: 4, total: 5, name: "implement" }, autonomous: true }), [
      PR(231, "OPEN", "running"),
    ]),
  ).toEqual({
    chip: "◌ Working",
    line: "containers 2 of 2 up · PRs stellwerk#231 Open · CI running · stage 4/5 implement",
    primary: "continue",
    session: ["continue", "new"],
    containers: ["stop", "pause", "restart", "down", "logs", "feature"],
    work: ["prs", "issue", "abandon"],
  });
  // 151: done, one service unhealthy, the PR released: Close out leads, Down replaces Stop.
  expect(
    card(
      sample({
        state: "partial",
        running: 1,
        claude: { agent: "done", at: null, question: null },
        lifecycle: { state: "shipped", prs: [{ dir: "stellwerk", status: "shipped", url: null }] },
        session: DESKTOP,
      }),
      [PR(186, "MERGED", "pass")],
    ),
  ).toEqual({
    chip: "✓ Done",
    line: "containers 1 of 2 up · PRs stellwerk#186 Merged · CI ✓ · Ready to close out",
    primary: "closeout",
    session: ["continue", "new", "pin"],
    containers: ["pause", "restart", "down", "logs", "feature"],
    work: ["prs", "issue", "closeout", "abandon"],
  });
  // SW-70: paused overrides Needs you; Resume leads, Stop and Down beside it, nothing that would run them.
  expect(
    card(
      sample({
        state: "paused",
        claude: { agent: "needs-you", at: null, question: "Q?" },
        paused: { at: "2026-10-20T11:48:00Z", containers: ["s-api"] },
        session: DESKTOP,
      }),
    ),
  ).toEqual({
    chip: "⏸ Paused",
    line: "containers paused · PRs None yet",
    primary: "resume",
    session: ["continue", "new", "pin"],
    containers: ["resume", "stop", "down"],
    work: ["prs", "issue", "abandon"],
  });
  // bwell: idle, no containers, no issue, JIT, an open PR failing CI: Up leads, Continue beside it.
  expect(
    card(
      sample({
        state: "down",
        running: 0,
        total: 0,
        issueId: null,
        issueUrl: null,
        phase: "implement",
        claude: { agent: "idle", at: null, question: null },
        session: DESKTOP,
      }),
      [PR(12, "OPEN", "fail", 2)],
    ),
  ).toEqual({
    chip: "Idle",
    line: "containers down · PRs stellwerk#12 Open · CI ✗ 2 failing · JIT · implement",
    primary: "up",
    session: ["continue", "new", "pin"],
    containers: ["up"],
    work: ["prs", "abandon"],
  });
});

test("actionsFor groups each container state's buttons, with and without a session (SW-105)", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const SHIPPED = {
    state: "shipped" as const,
    prs: [{ dir: "s", status: "shipped" as const, url: null }],
  };
  const states: Record<string, Partial<WorkspaceRow>> = {
    running: { state: "up" },
    paused: { state: "paused", paused: { at: "2026-10-20T11:00:00Z", containers: [] } },
    stopped: { state: "stopped", running: 0 },
    down: { state: "down", running: 0 },
    shipped: { state: "up", lifecycle: SHIPPED },
  };
  const sessions: Record<string, Partial<WorkspaceRow>> = {
    desktop: { session: DESKTOP },
    terminal: {},
    none: { sessionTitle: null, sessionOrigin: null },
  };
  const got: Record<string, unknown> = {};
  for (const [st, over] of Object.entries(states))
    for (const [se, sOver] of Object.entries(sessions)) {
      const r = sample({ ...over, ...sOver });
      const a = actionsFor(r, display(r, [], NOW), true);
      expect([...a.session, ...a.containers, ...a.work]).toContain(a.primary);
      got[`${st}/${se}`] = [a.primary, a.session, a.containers, a.work];
    }
  const LIVE = ["stop", "pause", "restart", "down", "logs", "feature"];
  const WORK = ["prs", "issue", "abandon"];
  expect(got).toEqual({
    "running/desktop": ["continue", ["continue", "new", "pin"], LIVE, WORK],
    "running/terminal": ["continue", ["continue", "new"], LIVE, WORK],
    "running/none": ["new", ["new"], LIVE, WORK],
    "paused/desktop": ["resume", ["continue", "new", "pin"], ["resume", "stop", "down"], WORK],
    "paused/terminal": ["resume", ["continue", "new"], ["resume", "stop", "down"], WORK],
    "paused/none": ["resume", ["new"], ["resume", "stop", "down"], WORK],
    "stopped/desktop": ["up", ["continue", "new", "pin"], ["up", "down"], WORK],
    "stopped/terminal": ["up", ["continue", "new"], ["up", "down"], WORK],
    "stopped/none": ["up", ["new"], ["up", "down"], WORK],
    "down/desktop": ["up", ["continue", "new", "pin"], ["up"], WORK],
    "down/terminal": ["up", ["continue", "new"], ["up"], WORK],
    "down/none": ["up", ["new"], ["up"], WORK],
    "shipped/desktop": [
      "closeout",
      ["continue", "new", "pin"],
      LIVE.slice(1),
      ["prs", "issue", "closeout", "abandon"],
    ],
    "shipped/terminal": [
      "closeout",
      ["continue", "new"],
      LIVE.slice(1),
      ["prs", "issue", "closeout", "abandon"],
    ],
    "shipped/none": ["closeout", ["new"], LIVE.slice(1), ["prs", "issue", "closeout", "abandon"]],
  });
  // No Input to type a reason in: no Abandon.
  const r = sample({});
  expect(actionsFor(r, display(r, [], NOW), false).work).toEqual(["prs", "issue"]);
});

test("▶ Start work shows, as the primary, only with no session and nothing in the first stage (SW-153)", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const FIRST = { index: 1, total: 4, name: "research" };
  const NONE = { sessionTitle: null, sessionOrigin: null };
  const card = (over: Partial<WorkspaceRow>) => {
    const r = sample(over);
    const a = actionsFor(r, display(r, [], NOW), true);
    return [a.primary, a.session];
  };
  for (const state of [
    { state: "up" },
    { state: "down", running: 0 },
    { state: "stopped", running: 0 },
  ] as const)
    expect(card({ ...state, ...NONE, stage: FIRST })).toEqual(["start", ["start", "new"]]);
  expect(card({ stage: FIRST })).toEqual(["continue", ["continue", "new"]]);
  expect(card({ stage: FIRST, session: DESKTOP })[1]).toEqual(["continue", "new", "pin"]);
  expect(card({ ...NONE, stage: { ...FIRST, index: 2 } })).toEqual(["new", ["new"]]);
  expect(card({ ...NONE, stage: null })).toEqual(["new", ["new"]]);
});

/** LIST with `empty` (no session) on its first stage, so its card offers ▶ Start work. */
const FRESH = {
  ...LIST,
  workspaces: LIST.workspaces.map((w) =>
    w.name === "empty" ? { ...w, stage: { index: 1, total: 4, name: "research" } } : w,
  ),
};
const AUTONOMOUS_ARGS = {
  title: "SW-1 Do it",
  model: "sonnet",
  prompt: "start the run\n\nRun limits:\n- …",
  background: "Workspace `empty` for SW-1. Read `CLAUDE.md`, then `.werkmeister/issue.md`.",
};
const INTERACTIVE_ARGS = {
  title: "empty",
  prompt: "start the run\n\nThis is an interactive run: check with me at each stage's human check.",
  background: "Workspace `empty`. Read `CLAUDE.md`, then `.werkmeister/issue.md`.",
};

for (const [kind, args] of [
  ["autonomous", AUTONOMOUS_ARGS],
  ["interactive", INTERACTIVE_ARGS],
] as const)
  test(`▶ Start work passes core's ${kind} start args to start_session in the workspace folder (SW-153)`, async ($, on) => {
    const w = world(
      on,
      stubs({
        [`${WS}/list-workspaces`]: () => ok(FRESH),
        [`${WS}/start-args`]: () => ok(args),
        "ccd_session/start_session": () => ok(undefined, "started local_42"),
      }),
    );
    await openPane($);
    const ui = await mountPane($);
    await tap(ui, "start:empty");
    expect(w.calls.find((c) => c.key === `${WS}/start-args`)?.args).toEqual({ path: "/ws/empty" });
    expect(w.calls.filter((c) => c.key === "ccd_session/start_session").map((c) => c.args)).toEqual(
      [
        {
          initiation: "user_asked",
          cwd: "/ws/empty",
          use_worktree: false,
          context: "fresh",
          ...args,
        },
      ],
    );
    expect(w.toasts).toContain(`Started "${args.title}". ⇆ Open beside on its card opens it.`);
    await ui.unmount();
  });

test("no second ▶ Start work while the first is starting (SW-153)", async ($, on) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () => ok(FRESH),
      [`${WS}/start-args`]: () => ok(INTERACTIVE_ARGS),
      "ccd_session/start_session": async () => {
        await gate;
        return ok(undefined, "started");
      },
    }),
  );
  await openPane($);
  const ui = await mountPane($);
  const first = tap(ui, "start:empty");
  await w.clock.settle();
  // While it starts the card draws "working…" in place of its buttons; BUSY drops any other press.
  expect(await seek(ui, "start:empty")).toBeUndefined();
  expect((await ui.find({ key: "busy:empty" }))?.text).toBe("working…");
  await tap(ui, "restart:ab");
  release();
  await first;
  expect(w.calls.filter((c) => c.key === "ccd_session/start_session")).toHaveLength(1);
  await ui.unmount();
});

for (const [kind, answer] of [
  [
    "refused",
    () => ({
      content: [{ type: "text" as const, text: "auto mode gave no verdict" }],
      isError: true,
    }),
  ],
  [
    "failed",
    () => {
      throw new Error("auto mode gave no verdict");
    },
  ],
] as const)
  test(`a ${kind} ▶ Start work drafts start_session's exact arguments for the person to send (SW-157)`, async ($, on) => {
    const filled: string[] = [];
    const w = world(
      on,
      stubs({
        [`${WS}/list-workspaces`]: () => ok(FRESH),
        [`${WS}/start-args`]: () => ok(AUTONOMOUS_ARGS),
        "ccd_session/start_session": answer,
      }),
    );
    on("prompt.fill", (_$, e) => {
      filled.push(e.text);
      return { isFilled: true };
    });
    await openPane($);
    const ui = await mountPane($);
    await tap(ui, "start:empty");
    expect(filled).toHaveLength(1);
    expect(filled[0]).toContain(
      JSON.stringify({
        initiation: "user_asked",
        cwd: "/ws/empty",
        use_worktree: false,
        context: "fresh",
        ...AUTONOMOUS_ARGS,
      }),
    );
    expect(w.calls.filter((c) => c.key === "ccd_session/start_session")).toHaveLength(1);
    expect((await ui.find({ key: "note" }))?.text).toBe(
      "empty: press Enter in the chat to start the run",
    );
    expect(w.toasts).toEqual([]);
    expect(await seek(ui, "new:empty")).toBeDefined();
    await ui.unmount();
  });

test("a refused ▶ Start work with no prompt box to draft in shows the reason (SW-157)", async ($, on) => {
  world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () => ok(FRESH),
      [`${WS}/start-args`]: () => ok(INTERACTIVE_ARGS),
      "ccd_session/start_session": () => ({
        content: [{ type: "text", text: "auto mode gave no verdict" }],
        isError: true,
      }),
    }),
  );
  on("prompt.fill", () => ({ isFilled: false }));
  await openPane($);
  const ui = await mountPane($);
  await tap(ui, "start:empty");
  expect((await ui.find({ key: "note" }))?.text).toBe(
    "empty: start refused: auto mode gave no verdict",
  );
  await ui.unmount();
});

test("Logs and Open feature run their core op for the card's workspace (SW-105)", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/follow-logs`]: () => ok({ feature: "ab" }),
      [`${WS}/open-feature`]: () => ok({ path: "/" }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "logs:ab");
  await tap(ui, "feature:ab");
  expect(
    w.calls.filter((c) => c.key === `${WS}/follow-logs` || c.key === `${WS}/open-feature`),
  ).toEqual([
    { key: `${WS}/follow-logs`, args: { name: "ab" }, via: "process" },
    { key: `${WS}/open-feature`, args: { name: "ab" }, via: "process" },
  ]);
  expect(w.toasts).toEqual([
    "Following ab's logs in a Terminal window",
    "Opening ab's feature in the browser",
  ]);
  await ui.unmount();
});

test("a lifecycle press calls workspace-action and refreshes", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-action`]: (a) =>
        ok(
          { command: `sandbox ${a.action}`, output: "done", path: "/ws/ab" },
          `sandbox ${a.action}\n\ndone`,
        ),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  const before = w.calls.filter((c) => c.key === `${WS}/list-workspaces`).length;
  await tap(ui, "stop:ab");
  const action = w.calls.find((c) => c.key === `${WS}/workspace-action`);
  expect(action?.args).toEqual({ name: "ab", action: "stop" });
  expect(w.calls.filter((c) => c.key === `${WS}/list-workspaces`).length).toBe(before + 1);
  expect((await ui.find({ key: "note" }))?.text).toBe("sandbox stop");
  await ui.unmount();
});

test("Pause and Resume run workspace-action like the other lifecycle verbs (SW-70)", async ($, on) => {
  const paused = {
    ...STATUS,
    statuses: STATUS.statuses.map((s) =>
      s.name === "abc"
        ? { ...s, state: "paused", paused: { at: "2026-10-20T11:00:00Z", containers: [] } }
        : s,
    ),
  };
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-status`]: () => ok(paused),
      [`${WS}/workspace-action`]: (a) =>
        ok({ command: `sandbox ${a.action}`, output: "done", path: "/ws/ab" }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "resume:abc" }))?.props.variant).toBe("primary");
  await tap(ui, "pause:ab");
  await tap(ui, "resume:abc");
  expect(w.calls.filter((c) => c.key === `${WS}/workspace-action`).map((c) => c.args)).toEqual([
    { name: "ab", action: "pause" },
    { name: "abc", action: "resume" },
  ]);
  await ui.unmount();
});

test("a pending Resume nudge is claimed and sent to the workspace's Desktop session, once", async ($, on) => {
  const nudged = {
    ...STATUS,
    // ab has no Desktop session: its nudge waits for the session's own next prompt.
    statuses: STATUS.statuses.map((s) => ({ ...s, resumeNudge: s.name !== "empty" })),
  };
  let pending = true;
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-status`]: () => ok(nudged),
      [`${WS}/claim-resume-nudge`]: () => {
        const message = pending
          ? "Workspace resumed by the person. Continue where you left off."
          : null;
        pending = false;
        return ok({ message });
      },
      "ccd_session_mgmt/get_session": () =>
        ok(undefined, JSON.stringify({ sessionId: "local_me" })),
      "ccd_session_mgmt/send_message": () =>
        ok(undefined, "Message delivered. (delivery: delivered; message_id: m1)"),
    }),
  );
  await openPane($);
  await w.clock.advance(5000);
  const claims = w.calls.filter((c) => c.key === `${WS}/claim-resume-nudge`);
  expect(claims.every((c) => c.args.name === "abc")).toBe(true);
  expect(
    w.calls.filter((c) => c.key === "ccd_session_mgmt/send_message").map((c) => c.args),
  ).toEqual([
    {
      session_id: "local_1",
      message: "Workspace resumed by the person. Continue where you left off.",
    },
  ]);
});

test("press while busy is ignored", async ($, on) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-action`]: async () => {
        await gate;
        return ok({ command: "x", output: "", path: "" });
      },
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  const first = tap(ui, "stop:ab");
  await w.clock.settle();
  expect((await ui.find({ key: "busy:ab" }))?.text).toBe("working…");
  await tap(ui, "restart:abc");
  release();
  await first;
  expect(w.calls.filter((c) => c.key === `${WS}/workspace-action`)).toHaveLength(1);
  await ui.unmount();
});

test("abandon asks for a reason in the pane, needs a second press, then closes out with it and archives", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/close-out`]: () =>
        ok({
          command: "sandbox close-out abc --abandon",
          output: "",
          path: "/ws/abc",
          terminals: ["terminal session: pid 9 on ttys001 in /ws/abc — /exit it"],
        }),
      "ccd_session_mgmt/archive_session": () => ok(undefined, "{}"),
    }),
  );
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    await tap(ui, "abandon:abc");
    expect((await seek(ui, "abandon:abc"))?.props.label).toBe("✕ Yes, abandon");
    await tap(ui, "abandon:abc");
    expect(w.calls.filter((c) => c.key === `${WS}/close-out`)).toHaveLength(0);
    expect((await ui.find({ key: "note" }))?.text).toBe("Give a reason to abandon");
    await ui.input({ key: "reason:abc", text: "superseded by #170" });
    await tap(ui, "abandon:abc");
    expect(w.calls.filter((c) => c.key === `${WS}/close-out`).map((c) => c.args)).toEqual([
      { name: "abc", abandon: "superseded by #170" },
    ]);
    // Inside the workspace (and below it), not elsewhere.
    expect(
      w.calls.filter((c) => c.key === "ccd_session_mgmt/archive_session").map((c) => c.args),
    ).toEqual([{ session_id: "local_1" }, { session_id: "local_2" }]);
    expect((await ui.find({ key: "note" }))?.text).toBe(
      'sandbox close-out abc --abandon\narchived "Newer in abc"\narchived "Older in abc"\nterminal session: pid 9 on ttys001 in /ws/abc — /exit it',
    );
    expect((await seek(ui, "abandon:abc"))?.props.label).toBe("✕ Abandon…");
    await ui.unmount();
    w.calls.length = 0;
  }
});

test("a press on another row's button clears the pending abandon and its reason", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-action`]: () =>
        ok({ command: "sandbox up", output: "", path: "" }, "sandbox up"),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "abandon:abc");
  await ui.input({ key: "reason:abc", text: "gone" });
  await tap(ui, "up:empty");
  expect((await seek(ui, "abandon:abc"))?.props.label).toBe("✕ Abandon…");
  expect(await ui.find({ key: "reason:abc" })).toBeUndefined();
  await tap(ui, "abandon:abc");
  await tap(ui, "abandon:abc");
  expect(w.calls.filter((c) => c.key === `${WS}/close-out`)).toHaveLength(0);
  await ui.unmount();
});

test("the close-out MCP tool archives the desktop sessions once it succeeded", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-path`]: (a) => ok({ path: `/ws/${a.name}` }),
      "ccd_session_mgmt/archive_session": (a) =>
        a.session_id === "local_2"
          ? { content: [{ type: "text", text: "session is pinned" }], isError: true }
          : ok(undefined, "{}"),
    }),
  );
  let failNext = false;
  on("tool.call", { tool: /werkmeister__close-out$/ }, () =>
    failNext
      ? { result: "not shipped", isError: true, text: "not shipped" }
      : { result: { command: "sandbox close-out abc" }, text: "sandbox close-out abc" },
  );
  const tool = "mcp__plugin_werkmeister_werkmeister__close-out";
  const r = await $.tool.call({ tool, workspace: "abc" } as never);
  expect(r.context).toEqual([
    'Desktop sessions in /ws/abc: archived "Newer in abc"; left open "Older in abc": session is pinned',
  ]);
  failNext = true;
  w.calls.length = 0;
  const failed = await $.tool.call({ tool, workspace: "abc" } as never);
  expect(failed.context ?? []).toEqual([]);
  expect(w.calls.filter((c) => c.key === "ccd_session_mgmt/archive_session")).toHaveLength(0);
});

test("polls every 5 s while open", async ($, on) => {
  const w = world(on, stubs());
  await openPane($);
  const count = () => w.calls.filter((c) => c.key === `${WS}/workspace-status`).length;
  const n = count();
  await w.clock.advance(5000);
  expect(count()).toBe(n + 1);
  await w.clock.advance(5000);
  expect(count()).toBe(n + 2);
});

// The kit's $ cannot raise ui.close itself; a helper plugin's $.ui.close raises it the way the engine does.
const CLOSER: Plugin = {
  name: "closer",
  register: (on) => {
    on("command.run", { command: "close-workspaces" }, async ($) => {
      await $.ui.close({ id: "workspaces" });
      return { text: "closed" };
    });
  },
};

test("closing the pane cancels the timer", { plugins: [CLOSER] }, async ($, on) => {
  const w = world(on, stubs());
  await openPane($);
  const count = () => w.calls.filter((c) => c.key === `${WS}/workspace-status`).length;
  const n = count();
  await w.clock.advance(5000);
  expect(count()).toBe(n + 1);
  await $.command.run({
    command: "close-workspaces",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  });
  await w.clock.advance(10000);
  expect(count()).toBe(n + 1);
});

test("a slow tick is skipped, not queued", async ($, on) => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let held = 0;
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: async () => {
        if (held++ === 1) await gate;
        return ok(LIST);
      },
    }),
  );
  await openPane($);
  await w.clock.advance(5000);
  await w.clock.advance(5000);
  await w.clock.advance(5000);
  release();
  await w.clock.settle();
  expect(w.calls.filter((c) => c.key === `${WS}/list-workspaces`)).toHaveLength(2);
});

test("New session opens the app's new-session link for the workspace folder", async ($, on) => {
  const w = world(on, stubs({ [`${WS}/open-claude-link`]: (a) => ok({ url: a.url }) }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "new:abc");
  expect(w.calls.find((c) => c.key === `${WS}/open-claude-link`)?.args).toEqual({
    url: "claude://code/new?folder=%2Fws%2Fabc&source=services",
  });
  expect(w.calls.some((c) => c.key === "ccd_directory/change_directory")).toBe(false);
  expect(w.toasts).toEqual([
    "Opening a new session in abc. To keep this pane in sight: right-click it in the sidebar → Open in → Split view",
  ]);
  await ui.unmount();
});

test("Open beside splits a session this one started beside this chat", async ($, on) => {
  const sessions = [{ ...SESSIONS[0], startedBy: "local_self" }, ...SESSIONS.slice(1)];
  const w = world(
    on,
    stubs({
      "ccd_session_mgmt/list_sessions": () => ok(undefined, JSON.stringify(sessions)),
      "ccd_window/open_session_in": () => ok({}),
      [`${WS}/open-claude-link`]: (a) => ok({ url: a.url }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "continue:abc");
  expect(w.calls.filter((c) => c.key === "ccd_window/open_session_in").map((c) => c.args)).toEqual([
    { session_id: "local_1", target: "split" },
  ]);
  expect(w.calls.some((c) => c.key === `${WS}/open-claude-link`)).toBe(false);
  expect(w.toasts).toEqual([]);
  await ui.unmount();
});

test("Open beside opens the session's own link when the app won't split it", async ($, on) => {
  const w = world(
    on,
    stubs({
      "ccd_window/open_session_in": () => ({
        content: [{ type: "text", text: "Only sessions this session started can be shown." }],
        isError: true,
      }),
      [`${WS}/open-claude-link`]: (a) => ok({ url: a.url }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await seek(ui, "continue:abc"))?.text).toBe("⇆ Open beside");
  await tap(ui, "continue:abc");
  expect(w.calls.find((c) => c.key === "ccd_window/open_session_in")?.args).toEqual({
    session_id: "local_1",
    target: "split",
  });
  expect(w.calls.find((c) => c.key === `${WS}/open-claude-link`)?.args).toEqual({
    url: "claude://x/local_1",
  });
  expect(w.toasts.join(" ")).toContain("Open in → Split view");
  await ui.unmount();
});

test("Pin toggles the sidebar pin of the card's session and redraws from the app's answer", async ($, on) => {
  let pinned = false;
  const w = world(
    on,
    stubs({
      "ccd_session_mgmt/list_sessions": () =>
        ok(
          undefined,
          JSON.stringify(SESSIONS.map((x) => (x.sessionId === "local_1" ? { ...x, pinned } : x))),
        ),
      "ccd_sidebar/set_pinned": (args) => {
        pinned = args.pinned as boolean;
        return ok({});
      },
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await seek(ui, "pin:abc"))?.text).toBe("📌 Pin");
  expect(await seek(ui, "pin:empty")).toBeFalsy();
  await tap(ui, "pin:abc");
  expect(w.calls.find((c) => c.key === "ccd_sidebar/set_pinned")?.args).toEqual({
    session_id: "local_1",
    pinned: true,
  });
  expect((await seek(ui, "pin:abc"))?.text).toBe("📌 Unpin");
  await ui.unmount();
});

test("a session starting in a folder of workspaces opens the pane; elsewhere it does not", async ($, on) => {
  const w = world(on, stubs());
  // Opening the pane loads the list once.
  const opened = () => w.calls.filter((c) => c.key === `${WS}/list-workspaces`).length;
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", (_$, e) => ({
    value:
      e.path === "/features"
        ? [{ name: "ab", kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false }]
        : [],
  }));
  on("fs.exists", (_$, e) => ({ value: e.path === "/features/ab/.werkmeister/workspace.yml" }));
  await $.session.start({ cwd: "/elsewhere", surface: "desktop", isInteractive: true });
  expect(opened()).toBe(0);
  await $.session.start({ cwd: "/features", surface: null, isInteractive: false });
  expect(opened()).toBe(0);
  await $.session.start({ cwd: "/features", surface: "desktop", isInteractive: true });
  expect(opened()).toBe(1);
});

test("a desktop session starting inside a workspace is filed under the Feature Workspaces group, once", async ($, on) => {
  let group: { id: string } | null = null;
  const w = world(
    on,
    stubs({
      "ccd_sidebar/list_groups": () =>
        ok(
          undefined,
          JSON.stringify([
            { id: "cg-1", name: "Other" },
            { id: "cg-2", name: "Feature Workspaces" },
          ]),
        ),
      "ccd_session_mgmt/get_session": () =>
        ok(undefined, JSON.stringify({ sessionId: "local_x", group })),
      "ccd_sidebar/move_sessions": (args) => {
        group = { id: args.group_id as string };
        return ok(undefined, "moved");
      },
    }),
  );
  const moves = () => w.calls.filter((c) => c.key === "ccd_sidebar/move_sessions");
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  on("fs.exists", (_$, e) => ({ value: e.path === "/features/ab/.werkmeister/workspace.yml" }));
  await $.session.start({ cwd: "/features", surface: "desktop", isInteractive: true });
  await $.session.start({ cwd: "/features/ab/sandbox", surface: "terminal", isInteractive: true });
  expect(moves()).toHaveLength(0);
  await $.session.start({ cwd: "/features/ab/sandbox", surface: "desktop", isInteractive: true });
  expect(moves().map((c) => c.args)).toEqual([{ session_ids: ["self"], group_id: "cg-2" }]);
  await $.session.start({ cwd: "/features/ab", surface: "desktop", isInteractive: true });
  expect(moves()).toHaveLength(1);
});

const BUNDLE = {
  schema: {
    properties: {
      issue_id: {
        type: "string",
        title: "Issue",
        pattern: "^$|(?:^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$)",
      },
      feature: { type: "string", title: "Feature name", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
      work_type: { type: "string", title: "Work type", enum: ["feature", "bugfix"] },
      services: {
        type: "array",
        title: "Services to run locally",
        items: { enum: ["api", "web"] },
      },
      task: {
        type: "string",
        title: "Task title",
        description: "Short title for the Current Task section.",
      },
      starting_prompt: { type: "string", title: "Starting prompt" },
    },
    required: ["feature", "work_type"],
  },
  uiSchema: {
    "ui:order": ["issue_id", "feature", "work_type", "services", "task", "starting_prompt"],
    feature: { "ui:placeholder": "my-feature" },
    services: {
      "ui:widget": "checkboxes",
      "ui:options": { groups: { web: ["web"], core: ["api"] } },
    },
    starting_prompt: {
      "ui:widget": "textarea",
      "ui:options": { refinable: true, refineInstruction: "Make it actionable." },
    },
  },
  formData: {},
};

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Answer the session model the way the issue distillation expects, recording what it was asked. */
function answerIssueModel(on: On): { model: string; prompt: string }[] {
  const asked: { model: string; prompt: string }[] = [];
  on("model.complete", (_$, e) => {
    asked.push({ model: e.model, prompt: e.prompt });
    return {
      value: {
        isAnswered: true as const,
        text: '<result>{"feature":"rate-limit"}</result>',
        usage: USAGE,
      },
    };
  });
  return asked;
}

const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

function validateStub(data: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [k, p] of Object.entries(BUNDLE.schema.properties) as [
    string,
    { pattern?: string },
  ][]) {
    const v = data[k];
    if (blank(v)) {
      if (BUNDLE.schema.required.includes(k)) errors[k] = "required";
    } else if (p.pattern && typeof v === "string" && !new RegExp(p.pattern).test(v))
      errors[k] = `"${v}" doesn't match the expected format`;
  }
  return errors;
}

function formStubs(over: Partial<McpStub> = {}): McpStub {
  return stubs({
    [`${WS}/form-schema`]: () => ok({ bundle: BUNDLE, trackerLabel: "GitHub" }),
    [`${WS}/issue-form-request`]: () =>
      ok({
        base: { issue_id: "acme/api#7", task: "Rate limit the API" },
        prompt: "EXTRACT acme/api#7",
      }),
    [`${WS}/issue-form-apply`]: (a) =>
      ok({ ...(a.base as Record<string, unknown>), feature: "rate-limit", services: ["api"] }),
    [`${WS}/create-workspace`]: () =>
      ok({ command: "sandbox workspace rate-limit", workspacePath: "/ws/api-7-rate-limit" }),
    [`${WS}/open-claude-link`]: (a) => ok({ url: a.url }),
    [`${WS}/refine-request`]: (args) => ok(`REFINE: ${String(args.text)}`),
    // Stand-ins for werkmeister-core's validateFormData and mergeFormData (form-validate.test.mjs tests the real ones).
    [`${WS}/validate-form`]: (a) => ok(validateStub(a.formData as Record<string, unknown>)),
    [`${WS}/merge-form`]: (a) => {
      const out = { ...(a.current as Record<string, unknown>) };
      for (const [k, v] of Object.entries(a.incoming as Record<string, unknown>))
        if (k === "issue_id" || blank(out[k])) out[k] = v;
      return ok(out);
    },
    ...over,
  });
}

test("the Create tab draws the form from the schema: titles without wizard hints, the issue named for the tracker", async ($, on) => {
  world(on, formStubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "create:go" })).toBeUndefined();
  await ui.press({ key: "tab:create" });
  for (const key of [
    "f:issue_id",
    "f:feature",
    "f:work_type",
    "f:services:api",
    "f:services:web",
    "f:task",
    "f:starting_prompt",
  ])
    expect(await ui.find({ key })).toBeDefined();
  expect((await ui.find({ key: "f:starting_prompt" }))?.type).toBe("Client");
  expect(await ui.find({ text: "GitHub issue" })).toBeDefined();
  expect(await ui.find({ text: "Task title" })).toBeDefined();
  expect(await ui.find({ text: "Feature name *" })).toBeDefined();
  expect(await ui.find({ text: "Short title for the Current Task section." })).toBeDefined();
  expect((await ui.find({ key: "create:fetch" }))?.text).toBe(
    "⤓ Fill empty fields from this issue",
  );
  await ui.unmount();
});

test("the multi-line field types across lines and its text reaches the create call", async ($, on) => {
  const w = world(on, formStubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  for (const key of ["a", "b", "return", "c", "backspace", "d", "up", "end", "!"])
    await ui.key({ key, in: "f:starting_prompt" });
  await ui.post({ value: "x" }, { in: "f:feature" });
  await ui.select({ key: "f:work_type", value: "feature" });
  await ui.press({ key: "create:go" });
  expect(
    (
      must(w.calls.find((c) => c.key === `${WS}/create-workspace`)).args as {
        formData: Record<string, unknown>;
      }
    ).formData.starting_prompt,
  ).toBe("ab!\nd");
  await ui.unmount();
});

test("text fields are plugin-drawn editors: a click draws the cursor in that field alone; Enter in the issue field fills from the issue", async ($, on) => {
  const w = world(on, formStubs());
  answerIssueModel(on);
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  for (const key of ["f:issue_id", "f:feature", "f:task"])
    expect((await ui.find({ key }))?.type).toBe("Client");
  const focusedOf = async (key: string) =>
    (must(await ui.find({ key })).props.props as { focused: boolean }).focused;
  await ui.pointer({ type: "down", x: 1, y: 0, button: "left", in: "f:feature" });
  expect([await focusedOf("f:feature"), await focusedOf("f:task")]).toEqual([true, false]);
  await ui.pointer({ type: "down", x: 1, y: 0, button: "left", in: "f:task" });
  expect([await focusedOf("f:feature"), await focusedOf("f:task")]).toEqual([false, true]);
  // A one-line Enter adds no line.
  for (const key of ["a", "return", "b"]) await ui.key({ key, in: "f:task" });
  for (const key of ["a", "p", "i", "#", "7", "return"]) await ui.key({ key, in: "f:issue_id" });
  expect(w.calls.find((c) => c.key === `${WS}/issue-form-request`)?.args).toEqual({ ref: "api#7" });
  await ui.post({ value: "x" }, { in: "f:feature" });
  await ui.select({ key: "f:work_type", value: "feature" });
  await ui.press({ key: "create:go" });
  expect(
    (
      must(w.calls.find((c) => c.key === `${WS}/create-workspace`)).args as {
        formData: Record<string, unknown>;
      }
    ).formData.task,
  ).toBe("ab");
  await ui.unmount();
});

test("fetch fills only the empty fields, distilled on the session model, then create submits the draft and returns to the list", async ($, on) => {
  const w = world(on, formStubs());
  const asked = answerIssueModel(on);
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "my-own" }, { in: "f:feature" });
  await ui.post({ value: "api#7" }, { in: "f:issue_id" });
  await ui.press({ key: "create:fetch" });
  expect(w.calls.find((c) => c.key === `${WS}/issue-form-request`)?.args).toEqual({ ref: "api#7" });
  expect(asked).toEqual([{ model: "sonnet", prompt: "EXTRACT acme/api#7" }]);
  expect(w.calls.find((c) => c.key === `${WS}/issue-form-apply`)?.args).toEqual({
    base: { issue_id: "acme/api#7", task: "Rate limit the API" },
    answer: '<result>{"feature":"rate-limit"}</result>',
  });
  expect((await ui.find({ text: /^Filled / }))?.text).toBe(
    "Filled task, services from acme/api#7.",
  );
  await ui.press({ key: "f:services:web" });
  await ui.select({ key: "f:work_type", value: "bugfix" });
  await ui.press({ key: "create:go" });
  expect(w.calls.find((c) => c.key === `${WS}/create-workspace`)?.args).toEqual({
    formData: {
      feature: "my-own",
      issue_id: "acme/api#7",
      task: "Rate limit the API",
      services: ["api", "web"],
      work_type: "bugfix",
    },
    distill: false,
  });
  expect(w.calls.find((c) => c.key === `${WS}/open-claude-link`)?.args).toEqual({
    url: "claude://code/new?folder=%2Fws%2Fapi-7-rate-limit&source=services",
  });
  expect(w.calls.some((c) => c.key === `${WS}/open-vscode`)).toBe(false);
  expect(w.toasts).toEqual(["Workspace created; opening a new session in it"]);
  expect(await seek(ui, "new:abc")).toBeDefined();
  await ui.unmount();
});

test("Create with an issue and empty fields fills from the issue on the session model and stops for review; the next press creates with distill off", async ($, on) => {
  const w = world(on, formStubs());
  const asked = answerIssueModel(on);
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "my-own" }, { in: "f:feature" });
  await ui.post({ value: "api#7" }, { in: "f:issue_id" });
  await ui.select({ key: "f:work_type", value: "bugfix" });
  await ui.press({ key: "create:go" });
  expect(asked).toEqual([{ model: "sonnet", prompt: "EXTRACT acme/api#7" }]);
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  expect((await ui.find({ key: "note" }))?.text).toBe(
    "Filled task, services from acme/api#7. Review, then press Create again.",
  );
  await ui.press({ key: "create:go" });
  expect(w.calls.find((c) => c.key === `${WS}/create-workspace`)?.args).toEqual({
    formData: {
      feature: "my-own",
      issue_id: "acme/api#7",
      task: "Rate limit the API",
      services: ["api"],
      work_type: "bugfix",
    },
    distill: false,
  });
  await ui.unmount();
});

test("a signed-out tracker shows on the infra line", async ($, on) => {
  world(
    on,
    stubs({
      [`${WS}/tracker-auth`]: () =>
        ok({ ok: false, reason: "not signed in", fix: "gh auth login" }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "terminal",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "infra" }))?.text).toMatch(/tracker: not signed in · gh auth login/);
  await ui.unmount();
});

test("a failed issue distillation still fills what the lookup found and says why", async ($, on) => {
  const w = world(on, formStubs());
  on("model.complete", () => ({
    value: { isAnswered: false as const, reason: "empty-reply" as const, usage: USAGE },
  }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "api#7" }, { in: "f:issue_id" });
  await ui.press({ key: "create:fetch" });
  expect(w.calls.some((c) => c.key === `${WS}/issue-form-apply`)).toBe(false);
  expect((await ui.find({ key: "note" }))?.text).toBe(
    "Filled task from acme/api#7. Couldn't distil the rest (empty-reply).",
  );
  await ui.unmount();
});

test("create with a required field empty or a bad value says why and creates nothing", async ($, on) => {
  const w = world(on, formStubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "Not A Slug" }, { in: "f:feature" });
  await ui.press({ key: "create:go" });
  expect((await ui.find({ text: /Work type: required/ }))?.text).toMatch(
    /Feature name: "Not A Slug" doesn't match[\s\S]*Work type: required/,
  );
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  await ui.unmount();
});

test("a multi-pick draws as checkboxes under its group headings, sorted, each in a fifth-width column", async ($, on) => {
  world(on, formStubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  expect(await ui.find({ text: "CORE" })).toBeDefined();
  expect(await ui.find({ text: "WEB" })).toBeDefined();
  expect((await ui.find({ key: "f:services:api" }))?.text).toBe("☐ api");
  await ui.press({ key: "f:services:api" });
  expect((await ui.find({ key: "f:services:api" }))?.text).toBe("☑ api");
  expect((await ui.find({ key: "cell:services:api" }))?.props.width).toBe("20%");
  await ui.unmount();
  const f = formFields(BUNDLE).find((x) => x.key === "services") as FormField;
  expect(optionGroups(f)).toEqual([
    ["core", ["api"]],
    ["web", ["web"]],
  ]);
  expect(optionGroups({ ...f, groups: { core: ["api"] } })).toEqual([
    ["core", ["api"]],
    ["other", ["web"]],
  ]);
  expect(optionGroups({ ...f, groups: {} })).toEqual([["", ["api", "web"]]]);
});

test("applyFormFields replaces, clears and checks values against the form", () => {
  const fields = formFields(BUNDLE);
  const r = applyFormFields(
    fields,
    { task: "old", feature: "keep" },
    {
      task: "",
      starting_prompt: "line one\nline two",
      work_type: "chore",
      services: "api, nope",
      bogus: "x",
    },
  );
  expect(r.draft).toEqual({
    task: "",
    feature: "keep",
    starting_prompt: "line one\nline two",
    services: ["api"],
  });
  expect(r.problems).toEqual([
    'work_type: "chore" is not offered (choices: feature, bugfix)',
    "services: not offered: nope (choices: api, web)",
    "bogus: no such field (fields: issue_id, feature, work_type, services, task, starting_prompt)",
  ]);
});

test('a boolean field is a check; workspaces_pane_fill_create_form takes "true" / "false" for it', () => {
  const bundle = {
    schema: { properties: { autonomous: { type: "boolean", title: "Autonomous run" } } },
    uiSchema: {},
    formData: { autonomous: false },
  };
  const fields = formFields(bundle as never);
  expect(fields[0]?.kind).toBe("check");
  expect(applyFormFields(fields, {}, { autonomous: "true" })).toEqual({
    draft: { autonomous: true },
    problems: [],
  });
  expect(applyFormFields(fields, { autonomous: true }, { autonomous: "maybe" }).problems).toEqual([
    "autonomous: expected true or false",
  ]);
});

test("the workspaces_pane_fill_create_form tool opens the Create tab filled, says what is still needed, and creates nothing", async ($, on) => {
  const w = world(on, formStubs());
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  await $.session.start({ cwd: "/elsewhere", surface: "desktop", isInteractive: true });
  const r = await $.tool.call({
    tool: "mcp__werkmeister__workspaces_pane_fill_create_form",
    fields: { feature: "rate-limit", starting_prompt: "Do it.\nThen test." },
  } as never);
  const text = String((r as { result?: unknown }).result);
  expect(text).toMatch(/"starting_prompt": "Do it.\\nThen test."/);
  expect(text).toMatch(/Still needed before Create:\n- Work type: required/);
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((must(await ui.find({ key: "f:feature" })).props.props as { value: string }).value).toBe(
    "rate-limit",
  );
  await ui.unmount();
});

test("Refine with Claude rewrites the starting prompt through the session model, not a claude child", async ($, on) => {
  const w = world(on, formStubs());
  const asked: { model: string; prompt: string }[] = [];
  on("model.complete", (_$, e) => {
    asked.push({ model: e.model, prompt: e.prompt });
    const text = `Sure.\n<result>\n## Goal\n${e.prompt.replace("REFINE: ", "")}, refined\n</result>`;
    return { value: { isAnswered: true as const, text, usage: USAGE } };
  });
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  expect(await ui.find({ key: "create:refine:task" })).toBeUndefined();
  await ui.press({ key: "create:refine:starting_prompt" });
  expect(await ui.find({ text: /Write something first/ })).toBeDefined();
  await ui.post({ value: "add a rate limit" }, { in: "f:starting_prompt" });
  await ui.post({ value: "rate-limit" }, { in: "f:feature" });
  await ui.press({ key: "create:refine:starting_prompt" });
  expect(w.calls.find((c) => c.key === `${WS}/refine-request`)?.args).toEqual({
    text: "add a rate limit",
    instruction: "Make it actionable.",
    formData: { starting_prompt: "add a rate limit", feature: "rate-limit" },
  });
  expect(asked).toEqual([{ model: "sonnet", prompt: "REFINE: add a rate limit" }]);
  expect(
    (must(await ui.find({ key: "f:starting_prompt" })).props.props as { value: string }).value,
  ).toBe("## Goal\nadd a rate limit, refined");
  await ui.unmount();
});

test("a failed Refine completion leaves the field and says why", async ($, on) => {
  world(on, formStubs());
  on("model.complete", () => ({
    value: { isAnswered: false as const, reason: "empty-reply" as const, usage: USAGE },
  }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "add a rate limit" }, { in: "f:starting_prompt" });
  await ui.press({ key: "create:refine:starting_prompt" });
  expect((await ui.find({ key: "note" }))?.text).toBe(
    "Refine failed (empty-reply); the field is unchanged.",
  );
  expect(
    (must(await ui.find({ key: "f:starting_prompt" })).props.props as { value: string }).value,
  ).toBe("add a rate limit");
  await ui.unmount();
});

test("Connect runs werkmeister connect, refreshes, and the infra line shows status", async ($, on) => {
  const infra = {
    state: "partial",
    running: 2,
    total: 3,
    services: [
      { name: "caddy", state: "healthy" },
      { name: "jaeger", state: "running" },
      { name: "k8s-forwards", state: "starting" },
    ],
  };
  const w = world(
    on,
    stubs({
      [`${WS}/workspace-status`]: () => ok({ ...STATUS, infra }),
      [`${WS}/connect`]: () => ok({ ok: true }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "infra" }))?.text).toBe(
    "infra partial · 2 of 3 up · starting: k8s-forwards",
  );
  const before = w.calls.filter((c) => c.key === `${WS}/workspace-status`).length;
  await ui.press({ key: "connect" });
  expect(w.calls.filter((c) => c.key === `${WS}/connect`)).toHaveLength(1);
  expect(w.calls.filter((c) => c.key === `${WS}/workspace-status`).length).toBe(before + 1);
  expect((await ui.find({ key: "note" }))?.text).toBe("werkmeister infra connect: done");
  await ui.unmount();
});

test('a text field types a space whether it arrives as " " or by name', () => {
  expect(edit({ text: "ab", cursor: 1 }, " ")).toEqual({ text: "a b", cursor: 2 });
  expect(edit({ text: "ab", cursor: 1 }, "space")).toEqual({ text: "a b", cursor: 2 });
  const s = { text: "ab", cursor: 1 };
  expect(edit(s, "tab")).toBe(s);
});

// docs/workspace-lifecycle.md: past `working`, a card shows the lifecycle instead of the stage,
// and offers ↻ PRs while a PR is in flight and ✓ Close out once shipped.
function lifecycleList(ab: unknown, abc: unknown) {
  return {
    ...LIST,
    workspaces: LIST.workspaces.map((w) =>
      w.name === "ab" ? { ...w, lifecycle: ab } : w.name === "abc" ? { ...w, lifecycle: abc } : w,
    ),
  };
}
const PR_OPEN = {
  state: "pr-open",
  prs: [
    { dir: "app", status: "open", url: "u" },
    { dir: "lib", status: "approved", url: null },
  ],
};
const SHIPPED = { state: "shipped", prs: [{ dir: "app", status: "shipped", url: "u" }] };

test("the lifecycle replaces the stage on the card and picks the lifecycle button", async ($, on) => {
  world(on, stubs({ [`${WS}/list-workspaces`]: () => ok(lifecycleList(PR_OPEN, SHIPPED)) }));
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "werkmeister",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    // An open PR has no lifecycle step: the stage stays the Workflow part.
    expect((await ui.find({ key: "meta:ab" }))?.text).toMatch(/ · stage 5\/6 implement$/);
    expect((await ui.find({ key: "meta:abc" }))?.text).toMatch(/ · Ready to close out$/);
    expect(await ui.find({ text: /PR open \(|\d\/\d · |shipped — / })).toBeUndefined();
    expect(await seek(ui, "closeout:ab")).toBeFalsy();
    expect(await seek(ui, "abandon:ab")).toBeTruthy();
    // abc needs you, so Continue leads (ui-spec § Actions) and Close out waits in ⋯.
    expect(await seek(ui, "closeout:abc")).toBeTruthy();
    expect(await seek(ui, "prs:empty")).toBeTruthy();
    await ui.unmount();
  }
});

// SW-50: a PR file still says `open` after the PR merged; the card's lifecycle follows the PR poll, not the file.
const API_OPEN = { dir: "api", status: "open", url: "https://github.com/o/api/pull/7" };
const WERKMEISTER_OPEN = {
  dir: "sandbox",
  status: "open",
  url: "https://github.com/o/sandbox/pull/12",
};

test("the lifecycle takes each PR's state from the PR poll, so it never contradicts the PR line", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () =>
        ok(
          lifecycleList(
            { state: "pr-open", prs: [API_OPEN] },
            { state: "pr-open", prs: [API_OPEN, WERKMEISTER_OPEN] },
          ),
        ),
      [`${WS}/workspace-prs`]: () => ok([PRS[0], { name: "abc", repos: PRS[0]?.repos }]),
    }),
  );
  await openPane($);
  await w.clock.settle();
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "meta:ab" }))?.text).toBe(
    "containers 3 of 3 up · PRs sandbox#12 Open, api#7 Merged · Awaiting release",
  );
  expect((await ui.find({ key: "meta:abc" }))?.text).toBe(
    "containers 1 of 3 up · PRs sandbox#12 Open, api#7 Merged",
  );
  await ui.unmount();
});

test("a failed PR poll says PRs unavailable on the card, and the lifecycle keeps the PR files", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () =>
        ok(lifecycleList({ state: "pr-open", prs: [API_OPEN] }, null)),
      [`${WS}/workspace-prs`]: () => ({
        content: [{ type: "text", text: "gh: not logged in" }],
        isError: true,
      }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await w.clock.settle();
  expect((await ui.find({ key: "meta:ab" }))?.text).toBe(
    "containers 3 of 3 up · PRs unavailable · retry · stage 5/6 implement",
  );
  await ui.unmount();
});

test("withLivePrs: shipped and abandoned outrank gh, a closed PR settles, an unpolled repo keeps its file", () => {
  const live = (state: "OPEN" | "MERGED" | "CLOSED") => [
    { repo: "api", branch: "b", url: API_OPEN.url, state, title: "t", labels: [] },
  ];
  const row = (prs: { dir: string; status: string; url: string | null }[]) =>
    ({ lifecycle: { state: "pr-open", prs } }) as unknown as WorkspaceRow;
  const r = row([{ ...API_OPEN, status: "shipped" }]);
  expect(withLivePrs(r, live("MERGED"))).toBe(r);
  expect(withLivePrs(row([API_OPEN]), live("CLOSED")).lifecycle?.state).toBe("shipped");
  expect(withLivePrs(row([API_OPEN, WERKMEISTER_OPEN]), live("MERGED")).lifecycle?.state).toBe(
    "pr-open",
  );
  const none = row([API_OPEN]);
  expect(withLivePrs(none, [])).toBe(none);
});

test("withLivePrs: a follow-up's live PR leaves the worktree's earlier PR file alone (SW-103)", () => {
  const followUp = { dir: "api", status: "approved", url: null };
  const merged = { ...API_OPEN, status: "merged" };
  const live = [
    {
      repo: "api",
      branch: "b-fix",
      url: "https://github.com/o/api/pull/8",
      state: "OPEN" as const,
      title: "t",
      labels: [],
    },
  ];
  const r = withLivePrs(
    { lifecycle: { state: "working", prs: [followUp, merged] } } as unknown as WorkspaceRow,
    live,
  );
  expect(r.lifecycle?.prs.map((p) => p.status)).toEqual(["open", "merged"]);
  expect(r.lifecycle?.state).toBe("pr-open");
});

test("↻ PRs runs pr-status for that workspace path", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () => ok(lifecycleList(PR_OPEN, null)),
      [`${WS}/pr-status`]: () => ok({ command: "app: merged" }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "prs:ab");
  expect(w.calls.filter((c) => c.key === `${WS}/pr-status`).map((c) => c.args)).toEqual([
    { path: "/ws/ab" },
  ]);
  await ui.unmount();
});

test("close-out needs two presses, and a press on another row's button cancels it", async ($, on) => {
  const w = world(
    on,
    stubs({
      [`${WS}/list-workspaces`]: () => ok(lifecycleList(null, SHIPPED)),
      [`${WS}/close-out`]: () => ok({ command: "sandbox close-out abc", output: "" }),
      [`${WS}/workspace-action`]: () =>
        ok({ command: "sandbox up", output: "", path: "" }, "sandbox up"),
      "ccd_session_mgmt/archive_session": () => ok(undefined, "{}"),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await tap(ui, "closeout:abc");
  expect((await seek(ui, "closeout:abc"))?.props.label).toBe("✓ Yes, close out");
  await tap(ui, "up:empty");
  expect((await seek(ui, "closeout:abc"))?.props.label).toBe("✓ Close out");
  await tap(ui, "closeout:abc");
  await tap(ui, "closeout:abc");
  expect(w.calls.filter((c) => c.key === `${WS}/close-out`).map((c) => c.args)).toEqual([
    { name: "abc" },
  ]);
  expect(w.calls.filter((c) => c.key === "ccd_session_mgmt/archive_session")).toHaveLength(2);
  await ui.unmount();
});

test("Create checks the draft with werkmeister-core's rules: no service or repo means no create", async ($, on) => {
  const repoRule =
    "Select at least one service (or add a repo below) — a workspace needs at least one repo.";
  const w = world(on, formStubs({ [`${WS}/validate-form`]: () => ok({ services: repoRule }) }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  await ui.post({ value: "rate-limit" }, { in: "f:feature" });
  await ui.press({ key: "create:go" });
  expect(w.calls.find((c) => c.key === `${WS}/validate-form`)?.args).toEqual({
    bundle: { schema: BUNDLE.schema },
    formData: { feature: "rate-limit" },
  });
  expect((await ui.find({ key: "note" }))?.text).toBe(`Services to run locally: ${repoRule}`);
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  await ui.unmount();
});

test("a desktop session runs the PR callback pass at start and every 10 min, and sends each desktop callback", async ($, on) => {
  const submitted: string[] = [];
  const w = world(on, {
    [`${WS}/pr-watch`]: () =>
      ok({
        ok: true,
        lines: [],
        desktop: [
          { dir: "app", url: "u1", hostSession: "local_other", message: "PR u1 merged." },
          { dir: "app", url: "u2", hostSession: "local_me", message: "PR u2 was closed." },
        ],
      }),
    "ccd_session_mgmt/get_session": () => ok(undefined, JSON.stringify({ sessionId: "local_me" })),
    "ccd_session_mgmt/send_message": () =>
      ok(undefined, "Message delivered. (delivery: delivered; message_id: m1)"),
  });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  on("fs.exists", () => ({ value: false }));
  on("prompt.submit", (_$, e) => {
    submitted.push(e.text);
    return { text: e.text };
  });
  const passes = () => w.calls.filter((c) => c.key === `${WS}/pr-watch`).length;
  const sends = () => w.calls.filter((c) => c.key === "ccd_session_mgmt/send_message");

  await $.session.start({ cwd: "/elsewhere", surface: "terminal", isInteractive: true });
  await w.clock.advance(600000);
  expect(passes()).toBe(0);

  await $.session.start({ cwd: "/elsewhere", surface: "desktop", isInteractive: true });
  await w.clock.advance(0);
  expect(passes()).toBe(1);
  expect(sends().map((c) => c.args)).toEqual([
    { session_id: "local_other", message: "PR u1 merged." },
  ]);
  // send_message refuses the calling session: its own callback is a prompt instead.
  expect(submitted).toEqual(["PR u2 was closed."]);

  await w.clock.advance(600000);
  expect(passes()).toBe(2);
});

// --- Intercept toggles (SW-2) -------------------------------------------------

const ODD = "front end; rm -rf /";
const IX_LIST = {
  ...LIST,
  workspaces: LIST.workspaces.map((w) => ({ ...w, feature: w.name === "ab" ? "ab" : null })),
};
const IX_STATUS = {
  ...STATUS,
  statuses: STATUS.statuses.map((st) =>
    st.name === "ab"
      ? {
          ...st,
          services: ["frontend", "backend", "api", "worker", ODD, "cli"].map((name) => ({
            name,
            state: "healthy",
          })),
        }
      : st,
  ),
};
const ixRow = (service: string, over: Record<string, unknown> = {}) => ({
  feature: "ab",
  service,
  deployment: service,
  interceptable: true,
  blocker: null,
  intercepted: false,
  intercepted_by: null,
  ...over,
});
const SNAP = {
  available: true,
  connected_namespace: "default",
  intercepts: [
    ixRow("frontend"),
    ixRow("backend", { intercepted: true, intercepted_by: "ab" }),
    ixRow("api", { intercepted: true, intercepted_by: "other" }),
    ixRow("worker", { interceptable: false, blocker: "has no k8s_port_name in services.yaml." }),
    ixRow(ODD),
    ixRow("cli", {
      deployment: null,
      interceptable: false,
      blocker: "has no k8s_deployment/k8s_namespace/k8s_port in services.yaml — not interceptable.",
    }),
  ],
  // cli has no k8s coordinates: a local-only service (SW-21).
  remote_services: ["api", "backend", "frontend", "worker", ODD],
};

function ixStubs(over: Partial<McpStub> = {}): McpStub {
  return stubs({
    [`${WS}/list-workspaces`]: () => ok(IX_LIST),
    [`${WS}/workspace-status`]: () => ok(IX_STATUS),
    [`${WS}/intercepts`]: () => ok(SNAP),
    [`${WS}/intercept-start`]: () => ok({ service: "frontend" }),
    [`${WS}/intercept-leave`]: () => ok({ left: ["backend"] }),
    ...over,
  });
}

async function mountPane($: Engine) {
  return $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
}

test("interceptControl: one state per rule, and an unreadable owner is never yours", () => {
  const row = (over: Record<string, unknown> = {}) => ixRow("frontend", over) as never;
  const kind = (r: never | undefined, feature: string | null, snap: typeof SNAP | null) =>
    interceptControl("frontend", r, feature, snap as never);
  expect(kind(row(), "ab", null)).toEqual({
    kind: "unavailable",
    text: "intercept state unavailable",
  });
  expect(kind(row(), "ab", { ...SNAP, available: false })?.text).toBe("intercepts unavailable");
  expect(kind(undefined, "ab", SNAP)?.kind).toBe("blocked");
  expect(kind(row({ intercepted: true, intercepted_by: "ab" }), "ab", SNAP)?.kind).toBe("active");
  expect(kind(row({ intercepted: true, intercepted_by: null }), "ab", SNAP)).toEqual({
    kind: "other",
    text: "⇄ intercepted (owner unknown)",
  });
  expect(kind(row({ intercepted: true, intercepted_by: "other" }), "ab", SNAP)?.text).toBe(
    "⇄ intercepted by 'other'",
  );
  expect(kind(row({ interceptable: false, blocker: "has no k8s_port." }), "ab", SNAP)?.text).toBe(
    "not interceptable: has no k8s_port.",
  );
  expect(kind(row(), "ab", SNAP)?.kind).toBe("off");
  expect(kind(row({ intercepted: true, intercepted_by: null }), null, SNAP)?.kind).toBe("other");
});

test("interceptControl: a local-only service gets no control, connected or not (SW-21)", () => {
  const cli = ixRow("cli", { interceptable: false, blocker: "has no k8s_deployment." }) as never;
  expect(interceptControl("cli", cli, "ab", SNAP as never)).toBeNull();
  expect(
    interceptControl("cli", undefined, "ab", { ...SNAP, available: false } as never),
  ).toBeNull();
  // A cluster service missing k8s_port_name is remote: it keeps its disabled control.
  const worker = SNAP.intercepts.find((r) => r.service === "worker") as never;
  expect(interceptControl("worker", worker, "ab", SNAP as never)?.kind).toBe("blocked");
});

test("interceptControl: not installed stays unavailable; installed but disconnected is off (SW-12)", () => {
  const frontend = ixRow("frontend") as never;
  const ctl = (snap: Record<string, unknown>) =>
    interceptControl("frontend", frontend, "ab", { ...SNAP, ...snap } as never);
  expect(ctl({ available: false, installed: false })?.text).toBe("intercepts unavailable");
  expect(ctl({ available: false, installed: true })?.kind).toBe("off");
  // A core older than SW-12 sends no `installed`: unavailable, as before.
  expect(ctl({ available: false })?.text).toBe("intercepts unavailable");
  for (const snap of [{ installed: false }, { installed: true }, {}]) {
    expect(
      interceptControl("cli", undefined, "ab", { ...SNAP, available: false, ...snap } as never),
    ).toBeNull();
  }
});

/** Telepresence on PATH, daemon not connected: rows present, nothing intercepted. */
const DISCONNECTED = {
  ...SNAP,
  available: false,
  installed: true,
  connected_namespace: null,
  intercepts: SNAP.intercepts.map((r) => ({ ...r, intercepted: false, intercepted_by: null })),
};

test("disconnected: Intercept says it connects first, then starts in docker mode (SW-12)", async ($, on) => {
  const w = world(on, ixStubs({ [`${WS}/intercepts`]: () => ok(DISCONNECTED) }));
  await openPane($);
  const ui = await mountPane($);
  await ui.press({ key: "intercept:ab/frontend" });
  expect(await ui.find({ text: /Connects telepresence \(docker\) first\./ })).toBeDefined();
  await ui.press({ key: "intercept-yes:ab/frontend" });
  const start = w.calls.find((c) => c.key === `${WS}/intercept-start`);
  expect(start?.args).toEqual({
    name: "ab",
    feature: "ab",
    service: "frontend",
    dockerDaemon: true,
  });
  expect((await ui.find({ key: "note" }))?.text).toBe("frontend: intercepted (x-feature: ab)");
  await ui.unmount();
});

test("each service line shows its intercept state; only off and yours get a button", async ($, on) => {
  world(on, ixStubs());
  await openPane($);
  const ui = await mountPane($);
  expect(await ui.find({ key: "intercept:ab/frontend" })).toBeDefined();
  expect(await ui.find({ key: "leave:ab/backend" })).toBeDefined();
  expect(await ui.find({ text: "⇄ intercepted by 'other'" })).toBeDefined();
  expect(await ui.find({ key: "intercept:ab/api" })).toBeUndefined();
  expect(await ui.find({ key: "leave:ab/api" })).toBeUndefined();
  expect(await ui.find({ text: /not interceptable: has no k8s_port_name/ })).toBeDefined();
  expect(await ui.find({ key: "intercept:ab/worker" })).toBeUndefined();
  // A local-only service has no control, so the compact card draws no line for it (SW-52).
  expect(await ui.find({ key: "svc:ab/cli" })).toBeUndefined();
  expect(await ui.find({ text: /not interceptable: has no k8s_deployment/ })).toBeUndefined();
  await ui.unmount();
});

test("a failed intercept lookup keeps the rows and service lines", async ($, on) => {
  world(
    on,
    ixStubs({
      [`${WS}/intercepts`]: () => ({
        content: [{ type: "text", text: "telepresence hung" }],
        isError: true,
      }),
    }),
  );
  await openPane($);
  const ui = await mountPane($);
  expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
  expect(await ui.find({ key: "svc:ab/frontend" })).toBeDefined();
  expect(await ui.find({ text: "intercept state unavailable" })).toBeDefined();
  expect(await ui.find({ key: "intercept:ab/frontend" })).toBeUndefined();
  await ui.unmount();
});

test("an intercept left outside the pane shows on the next poll", async ($, on) => {
  let left = false;
  const w = world(
    on,
    ixStubs({
      [`${WS}/intercepts`]: () =>
        ok(
          left
            ? {
                ...SNAP,
                intercepts: SNAP.intercepts.map((r) =>
                  r.service === "backend" ? ixRow("backend") : r,
                ),
              }
            : SNAP,
        ),
    }),
  );
  await openPane($);
  const ui = await mountPane($);
  expect(await ui.find({ key: "leave:ab/backend" })).toBeDefined();
  left = true;
  await w.clock.advance(5000);
  expect(await ui.find({ key: "leave:ab/backend" })).toBeUndefined();
  expect(await ui.find({ key: "intercept:ab/backend" })).toBeDefined();
  await ui.unmount();
});

test("Intercept asks first and starts only on yes; Leave runs at once", async ($, on) => {
  const w = world(on, ixStubs());
  await openPane($);
  const ui = await mountPane($);
  await ui.press({ key: "intercept:ab/frontend" });
  expect(w.calls.filter((c) => c.key === `${WS}/intercept-start`)).toHaveLength(0);
  expect(await ui.find({ text: /Installs a traffic-agent sidecar on frontend/ })).toBeDefined();
  expect(await ui.find({ text: /Connects telepresence/ })).toBeUndefined();
  await ui.press({ key: "intercept-yes:ab/frontend" });
  const starts = w.calls.filter((c) => c.key === `${WS}/intercept-start`);
  expect(starts.map((c) => [c.via, c.args])).toEqual([
    ["process", { name: "ab", feature: "ab", service: "frontend", dockerDaemon: true }],
  ]);
  expect((await ui.find({ key: "note" }))?.text).toBe("frontend: intercepted (x-feature: ab)");

  await ui.press({ key: "leave:ab/backend" });
  const leaves = w.calls.filter((c) => c.key === `${WS}/intercept-leave`);
  expect(leaves.map((c) => c.args)).toEqual([
    { name: "ab", feature: "ab", service: "backend", dockerDaemon: true },
  ]);
  await ui.unmount();
});

test("Cancel drops a pending intercept without starting it", async ($, on) => {
  const w = world(on, ixStubs());
  await openPane($);
  const ui = await mountPane($);
  await ui.press({ key: "intercept:ab/frontend" });
  await ui.press({ key: "intercept-cancel:ab/frontend" });
  expect(await ui.find({ key: "intercept-yes:ab/frontend" })).toBeUndefined();
  expect(w.calls.filter((c) => c.key === `${WS}/intercept-start`)).toHaveLength(0);
  await ui.unmount();
});

test("the service reaches werkmeister-core verbatim as a JSON field, never through a shell", async ($, on) => {
  const w = world(on, ixStubs());
  await openPane($);
  const ui = await mountPane($);
  await ui.press({ key: `intercept:ab/${ODD}` });
  await ui.press({ key: `intercept-yes:ab/${ODD}` });
  const start = w.calls.find((c) => c.key === `${WS}/intercept-start`);
  expect(start?.via).toBe("process");
  expect(start?.args.service).toBe(ODD);
  await ui.unmount();
});

test("a failed intercept start shows the error and clears busy", async ($, on) => {
  world(
    on,
    ixStubs({
      [`${WS}/intercept-start`]: () => ({
        content: [{ type: "text", text: "frontend is not listening on localhost:11101" }],
        isError: true,
      }),
    }),
  );
  await openPane($);
  const ui = await mountPane($);
  await ui.press({ key: "intercept:ab/frontend" });
  await ui.press({ key: "intercept-yes:ab/frontend" });
  expect((await ui.find({ key: "note" }))?.text).toBe(
    "frontend is not listening on localhost:11101",
  );
  expect(await ui.find({ key: "intercept:ab/frontend" })).toBeDefined();
  await ui.unmount();
});

test("SW-41: buildRows carries the start reason and crash loops; a missing status reads as none", () => {
  const started = { at: "2026-10-20T10:00:00Z", by: "gate" as const };
  const crashLoops = [{ service: "api", restarts: 3, lastLog: "boom" }];
  const rows = buildRows(
    {
      workspaces: [
        { name: "a", path: "/ws/a" },
        { name: "b", path: "/ws/b" },
      ] as never,
    },
    {
      statuses: [
        {
          name: "a",
          project: "sandbox-a",
          state: "up",
          running: 1,
          total: 1,
          services: [],
          claude: { state: "idle", agent: "idle" },
          started,
          crashLoops,
        },
      ],
    },
    [],
  );
  expect([rows[0]?.project, rows[0]?.started, rows[0]?.crashLoops]).toEqual([
    "sandbox-a",
    started,
    crashLoops,
  ]);
  expect([rows[1]?.project, rows[1]?.started, rows[1]?.crashLoops]).toEqual([null, null, []]);
});

test("SW-41: the card's vitals join on the project, and a crash loop is an error", () => {
  const NOW = new Date("2026-10-20T12:00:00Z");
  const r = sample({
    project: "sandbox-ab",
    services: [{ name: "api", state: "running" }],
    started: { at: "2026-10-20T10:00:00Z", by: "up" },
    crashLoops: [{ service: "api", restarts: 5, lastLog: "Error: EADDRINUSE" }],
  });
  const d = display(r, [], NOW, RESOURCES as never);
  expect(resourcesLine(d)).toBe("12.3% CPU · 410 MiB · started 2 h ago by up");
  expect(d.containers).toEqual({ text: "api crash-looping", tone: "err" });
  expect(d.crash?.text).toBe("✗ api crash-looping · 5 restarts · Error: EADDRINUSE");
  expect(resourcesLine(display(sample({}), [], NOW))).toBe("");
});

test("SW-41: the pane shows the host line and each card's vitals and crash line", async ($, on) => {
  const [ab, ...rest] = STATUS.statuses;
  world(
    on,
    stubs({
      [`${WS}/workspace-status`]: () =>
        ok({
          ...STATUS,
          statuses: [
            {
              ...ab,
              started: { at: "2026-10-20T10:00:00Z", by: "gate" },
              crashLoops: [{ service: "api", restarts: 2, lastLog: "exit 1" }],
            },
            ...rest,
          ],
        }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "host" }))?.text).toBe(
    "host load 3.2 · 2.8 · 2.1 / 10 cores · features 45% CPU",
  );
  expect((await ui.find({ key: "vitals:ab" }))?.text).toMatch(
    /^12\.3% CPU · 410 MiB · started .+ ago by gate$/,
  );
  expect((await ui.find({ key: "crash:ab" }))?.text).toBe(
    "✗ api crash-looping · 2 restarts · exit 1",
  );
  expect(await ui.find({ key: "crash:abc" })).toBeUndefined();
  await ui.unmount();
});
