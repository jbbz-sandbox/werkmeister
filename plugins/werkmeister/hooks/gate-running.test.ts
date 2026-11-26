import type { On } from "claude-code";
import { test as baseTest, expect, mock } from "claude-code/testing";

// The engine's 5 s default timed out cases on a loaded host (SW-666).
const test: typeof baseTest = (name, ...rest) => {
  const [options, body] = rest.length === 1 ? [{}, rest[0]] : rest;
  baseTest(name, { timeoutMs: 30_000, ...options }, body);
};

const WS = "/features/ws";
const NOW = Date.parse("2026-11-25T12:00:00Z");
const file = (name: string, mtimeMs = 0) => ({
  name,
  kind: "file" as const,
  size: 0,
  mtimeMs,
  isLink: false,
});

/** A workspace at WS with one proposed review.md, and `.werkmeister/gate-running` beaten at *beat* (none if undefined). */
function seed(on: On, beat?: number) {
  mock.clock(on, { now: NOW });
  on("classic.Stop", () => ({}));
  on("fs.exists", (_$, e) => ({ value: e.path === `${WS}/.werkmeister/workspace.yml` }));
  on("fs.list", (_$, e) => ({
    value:
      e.path === `${WS}/stages`
        ? [{ ...file("03_exercise"), kind: "dir" as const }]
        : e.path === `${WS}/stages/03_exercise/output`
          ? [file("review.md")]
          : e.path === `${WS}/.werkmeister`
            ? [file("last-exec", NOW), ...(beat === undefined ? [] : [file("gate-running", beat)])]
            : [],
  }));
  on("fs.read", (_$, e) => ({
    value: e.path === `${WS}/stages/03_exercise/output/review.md` ? "status: proposed\n" : "",
  }));
}

test("a turn that ends while the gate runs gets no proposed-item prompt (SW-1213)", async ($, on) => {
  seed(on, NOW - 30_000);
  expect((await $.classic.Stop({ stop_hook_active: false, cwd: WS })).block).toBeUndefined();
});

test("a marker a killed gate left stops counting after 3 missed beats (SW-1213)", async ($, on) => {
  seed(on, NOW - 3 * 60_000);
  expect((await $.classic.Stop({ stop_hook_active: false, cwd: WS })).block).toMatch(
    /^1 proposed item in stages\/03_exercise\/output\/review\.md/,
  );
});

test("with no gate running, a proposed item blocks; a fresh last-exec alone does not count (SW-1213)", async ($, on) => {
  seed(on);
  expect((await $.classic.Stop({ stop_hook_active: false, cwd: WS })).block).toMatch(
    /^1 proposed item/,
  );
});
