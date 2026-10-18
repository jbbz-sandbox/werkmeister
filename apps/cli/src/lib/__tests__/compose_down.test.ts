/**
 * `composeDown` used to return true unconditionally, so a failed
 * `docker compose down` was indistinguishable from one that worked
 * (known-issues.md, "Library Rough Edges"). The process boundary is mocked one
 * level down: `docker ps` resolves the workspace, `docker compose` tears down.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE, LEGACY_COMPOSE_FILE } from "werkmeister-core/compose_file";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

const h = vi.hoisted(() => ({
  workspace: "",
  composeStatus: 0,
  calls: [] as string[][],
}));

vi.mock("werkmeister-core/proc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werkmeister-core/proc")>();
  return {
    ...actual,
    run: (cmd: string[]) => {
      h.calls.push(cmd);
      if (cmd[1] === "ps") {
        return { status: 0, stdout: h.workspace + "\n", stderr: "" };
      }
      return { status: h.composeStatus, stdout: "", stderr: "boom" };
    },
  };
});
// The cwd/config fallback would otherwise consult this machine's ~/.sandbox.
vi.mock("werkmeister-core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werkmeister-core/config")>();
  return {
    ...actual,
    resolveWorkspace: () => {
      throw new Error("no workspace");
    },
  };
});

import { composeDown } from "werkmeister-core/compose";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "compose-down-"));
  h.workspace = tmp;
  h.composeStatus = 0;
  h.calls = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("composeDown", () => {
  it("reports a failed docker compose down", async () => {
    fs.writeFileSync(path.join(tmp, COMPOSE_FILE), "services: {}\n");
    h.composeStatus = 1;

    expect(await withReporter(quiet, async () => composeDown("demo"))).toBe(false);
  });

  it("reports success when compose succeeds", async () => {
    fs.writeFileSync(path.join(tmp, COMPOSE_FILE), "services: {}\n");

    expect(
      await withReporter(quiet, async () => composeDown("demo", { removeVolumes: true })),
    ).toBe(true);
    expect(h.calls.at(-1)).toContain("--volumes");
    // One workspace lookup, not one per layer.
    expect(h.calls.filter((c) => c[1] === "ps")).toHaveLength(1);
  });

  // A workspace generated before #224 keeps its docker-compose.yml until re-inited.
  it("tears down a workspace that only has the legacy file", async () => {
    fs.writeFileSync(path.join(tmp, LEGACY_COMPOSE_FILE), "services: {}\n");

    expect(await withReporter(quiet, async () => composeDown("demo"))).toBe(true);
    expect(h.calls.at(-1)).toEqual(
      expect.arrayContaining(["compose", "-f", path.join(tmp, LEGACY_COMPOSE_FILE), "down"]),
    );
  });

  it("is down already when the feature has no compose file", async () => {
    h.workspace = "";

    expect(await withReporter(quiet, async () => composeDown("demo"))).toBe(true);
    expect(h.calls.some((c) => c[1] === "compose")).toBe(false);
  });
});
