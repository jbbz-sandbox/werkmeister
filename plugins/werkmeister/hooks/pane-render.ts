// SW-623: scripts/render-pane.mjs copies this in as the only test of a temp plugin copy, so the
// normal suite never runs it. It prints the pane's drawn tree for the demo workspaces on one line.
import { mock, test } from "claude-code/testing";
import { DEMO, DEMO_NOW } from "./demo-fixture";

// The test runtime has console; the plugin's type lib does not declare it.
declare const console: { log(line: string): void };

const COLUMNS = 72; // scripts/render-pane.mjs paints at the same width

const done = { stderr: "", isStdoutTruncated: false, isStderrTruncated: false };

test("render the pane for the demo workspaces", async ($, on) => {
  const clock = mock.clock(on, { now: Date.parse(DEMO_NOW) });
  on("ui.open", () => ({ value: { isPlaced: true as const } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.panes", () => ({ value: [] }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("tool.register", (_$, e) => ({ value: { tool: `mcp__werkmeister__${e.name}` } }));
  // Every core op is the node child's; the one bash child is the install check.
  on("process.run", (_$, e) => {
    if (e.argv[0] === "bash") return { value: { exitCode: 0, stdout: "RESULT clean\n", ...done } };
    const { op } = JSON.parse(e.init?.stdin ?? "{}") as { op: string };
    const line =
      op in DEMO ? { ok: true, result: DEMO[op] } : { ok: false, error: `no demo ${op}` };
    return { value: { exitCode: 0, stdout: `${JSON.stringify(line)}\n`, ...done } };
  });
  on("mcp.call", () => ({
    value: { content: [{ type: "text" as const, text: "[]" }], isError: false },
  }));

  await $.command.run({
    command: "workspaces",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: COLUMNS },
  });
  await clock.settle();
  const ui = await $.ui.mount({
    plugin: "werkmeister",
    surface: "terminal",
    component: "Pane",
    props: {
      title: "Werkmeister workspaces",
      isFocused: false,
      bodyColumns: COLUMNS,
      placement: "dock" as const,
      scroll: { offset: 0, bodyRows: 200 },
      view: {},
    },
    requestId: "workspaces",
  });
  console.log(`DRAWN>${JSON.stringify(await ui.drawn())}`);
  await ui.unmount();
});
