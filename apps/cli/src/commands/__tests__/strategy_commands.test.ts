/**
 * In an icm workspace the JIT commands dispatch to icm: `skills check` reports
 * a fresh layer and exits 0, `hooks gate` prints nothing, `notes context`
 * prints nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectingReporter, withReporter } from "sandbox-core/reporter";
import type { StrategyId } from "sandbox-core/strategies";
import { STRATEGY_IDS, strategyById, strategyFor } from "sandbox-core/strategies";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run as hooks } from "../hooks.js";
import { run as notes } from "../notes.js";
import { run as skills } from "../skills.js";

let root: string;
let home: string;
let prevCfg: string | undefined;
// Resolved from workspace.yml below, never hardcoded (naming grep, Step 8).
let strategyId: StrategyId;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-home-"));
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `version: 1\noverrides:\n  standards_dir: ${path.join(home, "none")}\n`,
  );
  fs.writeFileSync(path.join(home, "services.yaml"), "services: {}\n");
  prevCfg = process.env.SANDBOX_CONFIG_FILE;
  process.env.SANDBOX_CONFIG_FILE = path.join(home, "config.yaml");

  root = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-ws-"));
  fs.mkdirSync(path.join(root, ".sandbox"));
  fs.writeFileSync(
    path.join(root, ".sandbox", "workspace.yml"),
    "context_strategy: icm\nwork_type: feature\n",
  );
  const strategy = strategyFor(root);
  strategyId = strategy.id;
  // Pin what this fixture actually resolved to — otherwise a regression in
  // readContextStrategy (falling back to jit) would make every assertion
  // below silently test jit and still pass.
  expect(strategyId).toBe(STRATEGY_IDS[0]); // icm: the first (default) entry
  strategy.init({
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: [],
    task: "demo",
    meta: { FEATURE: "", SERVICES: "" },
    inputs: { context_strategy: strategyId, work_type: "feature" },
    configOverride: null,
  });
  vi.spyOn(process, "cwd").mockReturnValue(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevCfg === undefined) delete process.env.SANDBOX_CONFIG_FILE;
  else process.env.SANDBOX_CONFIG_FILE = prevCfg;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("JIT commands in an icm workspace", () => {
  it("skills check reports a fresh icm layer and does not exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const c = collectingReporter();
    await withReporter(c, () => skills({ action: "check" }));
    expect(exit).not.toHaveBeenCalled();
    expect(c.text()).toContain(`Context layer fresh (${strategyId})`);
  });

  it("hooks gate prints nothing, dispatched to the icm strategy's gate", async () => {
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    const gateSpy = vi.spyOn(strategyById(strategyId), "gate");
    await hooks({ action: "gate" });
    expect(gateSpy).toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("notes context prints nothing", async () => {
    // Seed a handoff note under .sandbox/notes/ so the jit path WOULD print —
    // this distinguishes "icm has nothing to say" from "icm was never asked".
    fs.mkdirSync(path.join(root, ".sandbox", "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".sandbox", "notes", "001-handoff-start.md"),
      "---\ntype: handoff\nstatus: open\n---\n# Handoff\nstart here\n",
    );
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    await notes({ action: "context" });
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
