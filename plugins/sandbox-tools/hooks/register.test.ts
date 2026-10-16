import type { On } from "claude-code";
import type { Engine, Plugin } from "claude-code/testing";
import { expect, mock, test } from "claude-code/testing";
import { applyFormFields, formFields, optionGroups } from "./register";
import { edit } from "./textarea";

const SURFACES = ["terminal", "desktop"] as const;
const WS = "plugin:sandbox-tools:sandbox-workspace";
const PANE_PROPS = {
  title: "Sandbox workspaces",
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
  on("tool.register", (_$, e) => ({ value: { tool: `mcp__sandbox-tools__${e.name}` } }));
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
      plugin: "sandbox-tools",
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
      claude: { state: "running", waiting: false },
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
      claude: { state: "idle", waiting: true },
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
      claude: { state: "idle", waiting: false },
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
    ...over,
  };
}

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
    `${WS}/list-workspaces`,
    `${WS}/tracker-auth`,
    `${WS}/workspace-prs`,
    `${WS}/workspace-status`,
  ]);
});

test("rows draw name, issue, task, counts and claude note", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
    expect((await ui.find({ key: "issue:ab" }))?.text).toBe("spike: PROJ-1");
    expect(await ui.find({ key: "issue:abc" })).toBeUndefined();
    expect((await ui.find({ key: "task:ab" }))?.text).toBe("BWell");
    expect((await ui.find({ key: "desc:ab" }))?.text).toBe("BWell technologies");
    expect((await ui.find({ key: "meta:ab" }))?.text).toBe("stage 5/6 implement · 3/3");
    expect((await ui.find({ key: "claude:ab" }))?.text).toBe("◌ working");
    expect((await ui.find({ key: "row:abc" }))?.text).toBe("abc");
    expect(await ui.find({ key: "task:abc" })).toBeUndefined();
    expect(await ui.find({ key: "desc:abc" })).toBeUndefined();
    expect((await ui.find({ key: "meta:abc" }))?.text).toBe("bugfix · 1/3");
    expect((await ui.find({ key: "claude:abc" }))?.text).toBe("● waiting for you");
    expect(await ui.find({ key: "claude:empty" })).toBeUndefined();
    await ui.unmount();
  }
});

test("cards link the issue and each PR with its state", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "prs:ab" }))?.text).toMatch(
      /pr: o\/sandbox#12 ⑂ open.*pr: o\/api#7 ⑂ merged/,
    );
    expect((await ui.find({ key: "prs:ab" }))?.text).not.toMatch(/web/);
    expect(await ui.find({ key: "prs:abc" })).toBeUndefined();
    await ui.unmount();
  }
});

test("the Focus toggle shows only workspaces labelled focus", async ($, on) => {
  const list = {
    ...LIST,
    workspaces: LIST.workspaces.map((w) => (w.name === "abc" ? { ...w, labels: ["focus"] } : w)),
  };
  world(on, stubs({ [`${WS}/list-workspaces`]: () => ok(list) }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "terminal",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "row:abc" }))?.text).toBe("abc");
  expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
  await ui.press({ key: "focus" });
  expect(await ui.find({ key: "row:ab" })).toBeUndefined();
  expect((await ui.find({ key: "row:abc" }))?.text).toBe("abc");
  await ui.press({ key: "focus" });
  expect((await ui.find({ key: "row:ab" }))?.text).toBe("ab");
  await ui.unmount();
});

test("no counts when total is 0", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "row:empty" }))?.text).toBe("empty");
    expect(await ui.find({ key: "meta:empty" })).toBeUndefined();
    await ui.unmount();
  }
});

test("segment-aware join picks the deepest workspace and the newest session", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect((await ui.find({ key: "session:abc" }))?.text).toBe("session · Desktop · Newer in abc");
    expect((await ui.find({ key: "session:ab" }))?.text).toBe("session · CLI · Demo project");
    expect(await ui.find({ key: "session:empty" })).toBeUndefined();
    await ui.unmount();
  }
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "session:abc" })).toBeDefined();
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "row:ab" })).toBeDefined();
  expect(await ui.find({ key: "session:abc" })).toBeUndefined();
  await ui.unmount();
});

test("a card border follows the state", async ($, on) => {
  world(on, stubs());
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "ws:ab" }))?.props.borderColor).toBe("success");
  expect((await ui.find({ key: "ws:abc" }))?.props.borderColor).toBe("warning");
  expect((await ui.find({ key: "ws:empty" }))?.props.borderDimColor).toBe(true);
  await ui.unmount();
});

test("Continue with no desktop session is labelled Terminal and resumes there", async ($, on) => {
  const w = world(
    on,
    stubs({ [`${WS}/claude-resume`]: () => ok({ path: "/ws/ab", sessionId: "s1" }) }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "continue:ab" }))?.text).toBe("↗ Continue in Terminal");
  await ui.press({ key: "continue:ab" });
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "session:ab" }))?.text).toBe("session · VS Code · Demo project");
  expect((await ui.find({ key: "continue:ab" }))?.text).toBe("↗ Continue in VS Code");
  await ui.press({ key: "continue:ab" });
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  for (const name of ["ab", "abc", "empty"])
    expect((await ui.find({ key: `new:${name}` }))?.text).toBe("＋ New session");
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "row:ab" })).toBeDefined();
  expect((await ui.find({ key: "error" }))?.text).toBe("docker down");
  await ui.unmount();
});

test("buttons follow the extension gating", async ($, on) => {
  world(on, stubs());
  await openPane($);
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    expect(await ui.find({ key: "up:ab" })).toBeUndefined();
    expect(await ui.find({ key: "stop:ab" })).toBeDefined();
    expect(await ui.find({ key: "up:abc" })).toBeDefined();
    expect(await ui.find({ key: "stop:abc" })).toBeDefined();
    expect(await ui.find({ key: "up:empty" })).toBeDefined();
    expect(await ui.find({ key: "stop:empty" })).toBeUndefined();
    for (const k of ["restart:ab", "down:ab", "new:ab"])
      expect(await ui.find({ key: k })).toBeDefined();
    // One end button per card (#160): a spike with no PR files closes out; unshipped work abandons; Remove is gone.
    expect(await ui.find({ key: "closeout:ab" })).toBeDefined();
    expect(await ui.find({ key: "abandon:ab" })).toBeUndefined();
    expect(await ui.find({ key: "abandon:abc" })).toBeDefined();
    for (const n of ["ab", "abc", "empty"])
      expect(await ui.find({ key: `remove:${n}` })).toBeUndefined();
    await ui.unmount();
  }
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  const before = w.calls.filter((c) => c.key === `${WS}/list-workspaces`).length;
  await ui.press({ key: "stop:ab" });
  const action = w.calls.find((c) => c.key === `${WS}/workspace-action`);
  expect(action?.args).toEqual({ name: "ab", action: "stop" });
  expect(w.calls.filter((c) => c.key === `${WS}/list-workspaces`).length).toBe(before + 1);
  expect((await ui.find({ key: "note" }))?.text).toBe("sandbox stop");
  await ui.unmount();
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  const first = ui.press({ key: "stop:ab" });
  await w.clock.settle();
  expect((await ui.find({ key: "busy:ab" }))?.text).toBe("working…");
  await ui.press({ key: "up:abc" });
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
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    await ui.press({ key: "abandon:abc" });
    expect((await ui.find({ key: "abandon:abc" }))?.props.label).toBe("✕ Yes, abandon");
    await ui.press({ key: "abandon:abc" });
    expect(w.calls.filter((c) => c.key === `${WS}/close-out`)).toHaveLength(0);
    expect((await ui.find({ key: "note" }))?.text).toBe("Give a reason to abandon");
    await ui.input({ key: "reason:abc", text: "superseded by #170" });
    await ui.press({ key: "abandon:abc" });
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
    expect((await ui.find({ key: "abandon:abc" }))?.props.label).toBe("✕ Abandon…");
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "abandon:abc" });
  await ui.input({ key: "reason:abc", text: "gone" });
  await ui.press({ key: "up:empty" });
  expect((await ui.find({ key: "abandon:abc" }))?.props.label).toBe("✕ Abandon…");
  expect(await ui.find({ key: "reason:abc" })).toBeUndefined();
  await ui.press({ key: "abandon:abc" });
  await ui.press({ key: "abandon:abc" });
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
  on("tool.call", { tool: /sandbox-workspace__close-out$/ }, () =>
    failNext
      ? { result: "not shipped", isError: true, text: "not shipped" }
      : { result: { command: "sandbox close-out abc" }, text: "sandbox close-out abc" },
  );
  const tool = "mcp__plugin_sandbox-tools_sandbox-workspace__close-out";
  const r = await $.tool.call({ tool, name: "abc" } as never);
  expect(r.context).toEqual([
    'Desktop sessions in /ws/abc: archived "Newer in abc"; left open "Older in abc": session is pinned',
  ]);
  failNext = true;
  w.calls.length = 0;
  const failed = await $.tool.call({ tool, name: "abc" } as never);
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "new:abc" });
  expect(w.calls.find((c) => c.key === `${WS}/open-claude-link`)?.args).toEqual({
    url: "claude://code/new?folder=%2Fws%2Fabc&source=services",
  });
  expect(w.calls.some((c) => c.key === "ccd_directory/change_directory")).toBe(false);
  expect(w.toasts).toEqual([
    "Opening a new session in abc. To keep this pane in sight: right-click it in the sidebar → Open in → Split view",
  ]);
  await ui.unmount();
});

test("Continue in Desktop focuses a session this one started, else opens the session's own link", async ($, on) => {
  const w = world(
    on,
    stubs({
      "ccd_window/open_session_in": () => ({
        content: [{ type: "text", text: "Only sessions this session started can be focused." }],
        isError: true,
      }),
      [`${WS}/open-claude-link`]: (a) => ok({ url: a.url }),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "continue:abc" }))?.text).toBe("↗ Continue in Desktop");
  await ui.press({ key: "continue:abc" });
  expect(w.calls.find((c) => c.key === "ccd_window/open_session_in")?.args).toEqual({
    session_id: "local_1",
    target: "focus",
  });
  expect(w.calls.find((c) => c.key === `${WS}/open-claude-link`)?.args).toEqual({
    url: "claude://x/local_1",
  });
  await ui.unmount();
});

test("Open beside shows only for a session this one started, and splits it", async ($, on) => {
  // local_1 was started by this session (its starter is not listed); local_9 by a listed session.
  const sessions = [
    { ...SESSIONS[0], startedBy: "local_self" },
    {
      sessionId: "local_9",
      title: "Side of local_3",
      cwd: "/ws/empty",
      link: "claude://x/local_9",
      startedBy: "local_3",
    },
    SESSIONS[2],
  ];
  const w = world(
    on,
    stubs({
      "ccd_session_mgmt/list_sessions": () => ok(undefined, JSON.stringify(sessions)),
      "ccd_window/open_session_in": () => ok({}),
    }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "beside:abc" }))?.text).toBe("⇆ Open beside");
  expect(await ui.find({ key: "beside:empty" })).toBeFalsy();
  await ui.press({ key: "beside:abc" });
  expect(w.calls.find((c) => c.key === "ccd_window/open_session_in")?.args).toEqual({
    session_id: "local_1",
    target: "split",
  });
  expect(w.toasts).toEqual([]);
  await ui.unmount();
});

test("without a session this one started, there is no Open beside", async ($, on) => {
  world(
    on,
    stubs({ "ccd_session_mgmt/list_sessions": () => ok(undefined, JSON.stringify(SESSIONS)) }),
  );
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(await ui.find({ key: "continue:abc" })).toBeTruthy();
  expect(await ui.find({ key: "beside:abc" })).toBeFalsy();
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "pin:abc" }))?.text).toBe("📌 Pin");
  expect(await ui.find({ key: "pin:empty" })).toBeFalsy();
  await ui.press({ key: "pin:abc" });
  expect(w.calls.find((c) => c.key === "ccd_sidebar/set_pinned")?.args).toEqual({
    session_id: "local_1",
    pinned: true,
  });
  expect((await ui.find({ key: "pin:abc" }))?.text).toBe("📌 Unpin");
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
  on("fs.exists", (_$, e) => ({ value: e.path === "/features/ab/.sandbox/workspace.yml" }));
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
  on("fs.exists", (_$, e) => ({ value: e.path === "/features/ab/.sandbox/workspace.yml" }));
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
        title: "GitHub issue (blank to skip)",
        pattern: "^$|(?:^([A-Za-z0-9_.-]+/)?[A-Za-z0-9_.-]+#[0-9]+$)",
      },
      feature: { type: "string", title: "Feature name", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$" },
      work_type: { type: "string", title: "Work type", enum: ["feature", "bugfix"] },
      services: { type: "array", title: "Local services", items: { enum: ["api", "web"] } },
      task: {
        type: "string",
        title: "Task title (Enter for default)",
        description: "Short title for the Current Task section.",
      },
      starting_prompt: { type: "string", title: "Starting prompt (blank to skip)" },
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
    // Stand-ins for sandbox-core's validateFormData and mergeFormData (form-validate.test.mjs tests the real ones).
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
    plugin: "sandbox-tools",
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
    plugin: "sandbox-tools",
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
      w.calls.find((c) => c.key === `${WS}/create-workspace`)?.args as {
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "tab:create" });
  for (const key of ["f:issue_id", "f:feature", "f:task"])
    expect((await ui.find({ key }))?.type).toBe("Client");
  const focusedOf = async (key: string) =>
    ((await ui.find({ key }))?.props.props as { focused: boolean }).focused;
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
      w.calls.find((c) => c.key === `${WS}/create-workspace`)?.args as {
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
    plugin: "sandbox-tools",
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
  expect(await ui.find({ key: "new:abc" })).toBeDefined();
  await ui.unmount();
});

test("Create with an issue and empty fields fills from the issue on the session model and stops for review; the next press creates with distill off", async ($, on) => {
  const w = world(on, formStubs());
  const asked = answerIssueModel(on);
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
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
    plugin: "sandbox-tools",
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
    plugin: "sandbox-tools",
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
    plugin: "sandbox-tools",
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
    plugin: "sandbox-tools",
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
  const f = formFields(BUNDLE).find((x) => x.key === "services")!;
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

test('a boolean field is a check; workspace_form takes "true" / "false" for it', () => {
  const bundle = {
    schema: { properties: { autonomous: { type: "boolean", title: "Autonomous run" } } },
    uiSchema: {},
    formData: { autonomous: false },
  };
  const fields = formFields(bundle as never);
  expect(fields[0]!.kind).toBe("check");
  expect(applyFormFields(fields, {}, { autonomous: "true" })).toEqual({
    draft: { autonomous: true },
    problems: [],
  });
  expect(applyFormFields(fields, { autonomous: true }, { autonomous: "maybe" }).problems).toEqual([
    "autonomous: expected true or false",
  ]);
});

test("the workspace_form tool opens the Create tab filled, says what is still needed, and creates nothing", async ($, on) => {
  const w = world(on, formStubs());
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("fs.list", () => ({ value: [] }));
  await $.session.start({ cwd: "/elsewhere", surface: "desktop", isInteractive: true });
  const r = await $.tool.call({
    tool: "mcp__sandbox-tools__workspace_form",
    fields: { feature: "rate-limit", starting_prompt: "Do it.\nThen test." },
  } as never);
  const text = String((r as { result?: unknown }).result);
  expect(text).toMatch(/"starting_prompt": "Do it.\\nThen test."/);
  expect(text).toMatch(/Still needed before Create:\n- Work type: required/);
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect(((await ui.find({ key: "f:feature" }))?.props.props as { value: string }).value).toBe(
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
    plugin: "sandbox-tools",
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
    ((await ui.find({ key: "f:starting_prompt" }))?.props.props as { value: string }).value,
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
    plugin: "sandbox-tools",
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
    ((await ui.find({ key: "f:starting_prompt" }))?.props.props as { value: string }).value,
  ).toBe("add a rate limit");
  await ui.unmount();
});

test("Connect runs sandbox connect, refreshes, and the infra line shows status", async ($, on) => {
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  expect((await ui.find({ key: "infra" }))?.text).toBe(
    "infra · partial · 2/3 · starting: k8s-forwards",
  );
  const before = w.calls.filter((c) => c.key === `${WS}/workspace-status`).length;
  await ui.press({ key: "connect" });
  expect(w.calls.filter((c) => c.key === `${WS}/connect`)).toHaveLength(1);
  expect(w.calls.filter((c) => c.key === `${WS}/workspace-status`).length).toBe(before + 1);
  expect((await ui.find({ key: "note" }))?.text).toBe("sandbox connect: done");
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
      plugin: "sandbox-tools",
      surface,
      component: "Pane",
      props: PANE_PROPS,
      requestId: "workspaces",
    });
    // ab has an issue, so its issue line carries the work type, not the meta line.
    expect((await ui.find({ key: "meta:ab" }))?.text).toBe("PR open (1/2) · 3/3");
    expect((await ui.find({ key: "meta:abc" }))?.text).toBe("bugfix · shipped — close out · 1/3");
    expect(await ui.find({ key: "prs:ab" })).toBeTruthy();
    expect(await ui.find({ key: "closeout:ab" })).toBeFalsy();
    expect(await ui.find({ key: "abandon:ab" })).toBeTruthy();
    expect(await ui.find({ key: "closeout:abc" })).toBeTruthy();
    expect(await ui.find({ key: "prs:empty" })).toBeFalsy();
    await ui.unmount();
  }
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "prs:ab" });
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
    plugin: "sandbox-tools",
    surface: "desktop",
    component: "Pane",
    props: PANE_PROPS,
    requestId: "workspaces",
  });
  await ui.press({ key: "closeout:abc" });
  expect((await ui.find({ key: "closeout:abc" }))?.props.label).toBe("✓ Yes, close out");
  await ui.press({ key: "up:empty" });
  expect((await ui.find({ key: "closeout:abc" }))?.props.label).toBe("✓ Close out");
  await ui.press({ key: "closeout:abc" });
  await ui.press({ key: "closeout:abc" });
  expect(w.calls.filter((c) => c.key === `${WS}/close-out`).map((c) => c.args)).toEqual([
    { name: "abc" },
  ]);
  expect(w.calls.filter((c) => c.key === "ccd_session_mgmt/archive_session")).toHaveLength(2);
  await ui.unmount();
});

test("Create checks the draft with sandbox-core's rules: no service or repo means no create", async ($, on) => {
  const repoRule =
    "Select at least one service (or add a repo below) — a workspace needs at least one repo.";
  const w = world(on, formStubs({ [`${WS}/validate-form`]: () => ok({ services: repoRule }) }));
  await openPane($);
  const ui = await $.ui.mount({
    plugin: "sandbox-tools",
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
  expect((await ui.find({ key: "note" }))?.text).toBe(`Local services: ${repoRule}`);
  expect(w.calls.some((c) => c.key === `${WS}/create-workspace`)).toBe(false);
  await ui.unmount();
});
