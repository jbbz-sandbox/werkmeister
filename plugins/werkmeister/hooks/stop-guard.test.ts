import type { On } from "claude-code";
import { test as baseTest, expect } from "claude-code/testing";

// The engine's 5 s default timed out cases on a loaded host (SW-666).
const test: typeof baseTest = (name, ...rest) => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest;
  baseTest(name, { timeoutMs: 30_000, ...options }, body);
};

const WS = "/features/ws";
const DECISIONS = `${WS}/stages/01_research/output/decisions.md`;
const TRANSCRIPT = "/t/session.jsonl";

/** A workspace at WS whose decisions.md holds *decisions* (read at each stop), and a session transcript at TRANSCRIPT. */
function seed(on: On, decisions: string | (() => string), workspaceYml = "", transcript = "") {
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
        ? typeof decisions === "string"
          ? decisions
          : decisions()
        : e.path === `${WS}/.werkmeister/workspace.yml`
          ? workspaceYml
          : e.path === TRANSCRIPT
            ? transcript
            : "",
  }));
}

const PROPOSED = "# Decisions\n\n## Q1\n\nstatus: proposed\n";

test("a proposed item blocks the stop (SW-1157)", async ($, on) => {
  seed(on, PROPOSED);
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS });
  expect(r.block).toBe(
    "1 proposed item in stages/01_research/output/decisions.md: walk them with AskUserQuestion (batches of 4, recommended first), then flip each to decided with the approved-in-chat note.",
  );
});

test("an autonomous workspace is told to self-check, not to ask the person (SW-1157)", async ($, on) => {
  seed(on, PROPOSED, "autonomous: true\n");
  const r = await $.classic.Stop({ stop_hook_active: false, cwd: WS });
  expect(r.block).toMatch(
    /^1 proposed item in .*: flip the ones your self-check settles to decided/,
  );
});

// SW-1185: 7 items, the first batch of 4 asked, answered and flipped; the other 3 were never asked.
// The transcript holds that answered question: the old guard let the stop through on it.
test("proposed items left after an answered batch still block (SW-1185)", async ($, on) => {
  const seven = ["decided", "decided", "decided", "decided", "proposed", "proposed", "proposed"];
  const decisions = `# Decisions\n\n${seven.map((s, i) => `## Q${i + 1}\n\nstatus: ${s}\n`).join("\n")}`;
  const transcript = [
    { type: "user", message: { content: "go on" } },
    {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: {} }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "q1", content: "A" }] },
    },
  ];
  seed(on, decisions, "", transcript.map((x) => JSON.stringify(x)).join("\n"));
  const r = await $.classic.Stop({
    stop_hook_active: false,
    cwd: WS,
    transcript_path: TRANSCRIPT,
  });
  expect(r.block).toMatch(/^3 proposed items in stages\/01_research\/output\/decisions\.md: /);
});

test("no proposed item, or outside a workspace: the stop goes through (SW-1157)", async ($, on) => {
  seed(on, "status: decided\n");
  const stop = (cwd: string) => $.classic.Stop({ stop_hook_active: false, cwd });
  expect((await stop(WS)).block).toBeUndefined();
  expect((await stop("/elsewhere")).block).toBeUndefined();
});

test("stop_hook_active lets a proposed gate end, so a deferral is not trapped (SW-1157)", async ($, on) => {
  seed(on, PROPOSED);
  const r = await $.classic.Stop({ stop_hook_active: true, cwd: WS });
  expect(r.block).toBeUndefined();
});

// SW-1185 review: after one block the continued turn's stops carry stop_hook_active; asking 4 of 7
// and stopping again must not let the other 3 through. Only a stop with no progress is a deferral.
test("with stop_hook_active it blocks again while the count falls, not when it holds (SW-1185)", async ($, on) => {
  const items = (left: number) =>
    Array.from(
      { length: 7 },
      (_, i) => `## Q${i + 1}\n\nstatus: ${i < 7 - left ? "decided" : "proposed"}\n`,
    ).join("\n");
  let left = 7;
  seed(on, () => items(left));
  const stop = (active: boolean) => $.classic.Stop({ stop_hook_active: active, cwd: WS });
  expect((await stop(false)).block).toMatch(/^7 proposed items/);
  left = 3;
  expect((await stop(true)).block).toMatch(/^3 proposed items/);
  expect((await stop(true)).block).toBeUndefined();
  // Once a stop went through, the next block starts over.
  expect((await stop(false)).block).toMatch(/^3 proposed items/);
});
