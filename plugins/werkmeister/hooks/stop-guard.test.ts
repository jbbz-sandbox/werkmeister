import type { On } from "claude-code";
import { test as baseTest, expect } from "claude-code/testing";
import { answeredThisTurn } from "./stop-guard";

// The engine's 5 s default timed out cases on a loaded host (SW-666).
const test: typeof baseTest = (name, ...rest) => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest;
  baseTest(name, { timeoutMs: 30_000, ...options }, body);
};

const WS = "/features/ws";
const DECISIONS = `${WS}/stages/01_research/output/decisions.md`;
const TRANSCRIPT = "/t/session.jsonl";

const line = (x: unknown) => JSON.stringify(x);
const prompt = line({ type: "user", message: { content: "go on" } });
const ask = line({
  type: "assistant",
  message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] },
});
const answer = (isError = false) =>
  line({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "q1", is_error: isError, content: "ok" }],
    },
  });

/** A workspace at WS whose decisions.md holds *decisions*, and a transcript of *transcript* lines. */
function seed(on: On, decisions: string, transcript: string[], workspaceYml = "") {
  // The engine's own answer beneath the plugin: let the stop through.
  on("classic.Stop", () => ({}));
  on("fs.exists", (_$, e) => ({ value: e.path === `${WS}/.werkmeister/workspace.yml` }));
  on("fs.list", (_$, e) => ({
    value:
      e.path === `${WS}/stages`
        ? [{ name: "01_research", kind: "dir" as const, size: 0, mtimeMs: 0, isLink: false }]
        : e.path === `${WS}/stages/01_research/output`
          ? [{ name: "decisions.md", kind: "file" as const, size: 1, mtimeMs: 0, isLink: false }]
          : [],
  }));
  on("fs.read", (_$, e) => ({
    value:
      e.path === DECISIONS
        ? decisions
        : e.path === TRANSCRIPT
          ? transcript.join("\n")
          : e.path === `${WS}/.werkmeister/workspace.yml`
            ? workspaceYml
            : "",
  }));
}

const PROPOSED = "# Decisions\n\n## Q1\n\nstatus: proposed\n";

test("a proposed item with nothing asked this turn blocks the stop (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, [prompt]);
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS, transcript_path: TRANSCRIPT });
  expect(r.block).toBe(
    "1 proposed item in stages/01_research/output/decisions.md: walk them with AskUserQuestion (batches of 4, recommended first), then flip each to decided with the approved-in-chat note.",
  );
});

test("an autonomous workspace is told to self-check, not to ask the person (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, [prompt], "autonomous: true\n");
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS, transcript_path: TRANSCRIPT });
  expect(r.block).toMatch(
    /^1 proposed item in .*: flip the ones your self-check settles to decided/,
  );
});

test("an answered question this turn lets the stop through (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, [prompt, ask, answer()]);
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS, transcript_path: TRANSCRIPT });
  expect(r.block).toBeUndefined();
});

test("an interrupted (errored) question still blocks (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, [prompt, ask, answer(true)]);
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS, transcript_path: TRANSCRIPT });
  expect(r.block).toMatch(/^1 proposed item/);
});

test("no proposed item, outside a workspace, or already reminded: the stop goes through (SW-1157)", async ($, on) => {
  seed(on, "status: decided\n", [prompt]);
  const stop = (cwd: string, active = false) =>
    $.classic.Stop({ stop_hook_active: active, cwd, transcript_path: TRANSCRIPT });
  expect((await stop(WS)).block).toBeUndefined();
  expect((await stop("/elsewhere")).block).toBeUndefined();
});

test("stop_hook_active lets a proposed gate end, so a deferral is not trapped (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, [prompt]);
  const r = await $.classic.Stop({ stop_hook_active: true, cwd: WS, transcript_path: TRANSCRIPT });
  expect(r.block).toBeUndefined();
});

test("an answer before the last typed prompt does not count (SW-1157)", () => {
  expect(answeredThisTurn([ask, answer(), prompt].join("\n"))).toBe(false);
  expect(answeredThisTurn([prompt, ask, answer()].join("\n"))).toBe(true);
  expect(answeredThisTurn(`${prompt}\n{torn`)).toBe(false);
});
