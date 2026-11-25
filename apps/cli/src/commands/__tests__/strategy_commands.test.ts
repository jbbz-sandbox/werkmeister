/**
 * In an icm workspace the JIT commands dispatch to icm: `skills check` reports
 * a fresh layer and exits 0, `hooks gate` prints nothing, `notes context`
 * prints nothing.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectingReporter, withReporter } from "werkmeister-core/reporter";
import type { StrategyId } from "werkmeister-core/strategies";
import { STRATEGY_IDS, strategyById, strategyFor } from "werkmeister-core/strategies";

import { run as hooks } from "../hooks.js";
import { run as notes } from "../notes.js";
import { run as skills } from "../skills.js";

let wsRoot: string;
let root: string;
let home: string;
let prevCfg: string | undefined;
// Resolved from workspace.yml below, never hardcoded (naming grep, Step 8).
let strategyId: StrategyId;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-home-"));
  wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "strategy-cmd-ws-"));
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `version: 1\npaths:\n  workspaces_root: ${wsRoot}\n` +
      `overrides:\n  standards_dir: ${path.join(home, "none")}\n`,
  );
  fs.writeFileSync(path.join(home, "services.yaml"), "services: {}\n");
  prevCfg = process.env.WERKMEISTER_CONFIG_FILE;
  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "config.yaml");

  root = path.join(wsRoot, "ws");
  fs.mkdirSync(path.join(root, ".werkmeister"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".werkmeister", "workspace.yml"),
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
  if (prevCfg === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
  else process.env.WERKMEISTER_CONFIG_FILE = prevCfg;
  fs.rmSync(wsRoot, { recursive: true, force: true });
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
    // Seed a handoff note under .werkmeister/notes/ so the jit path WOULD print —
    // this distinguishes "icm has nothing to say" from "icm was never asked".
    fs.mkdirSync(path.join(root, ".werkmeister", "notes"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".werkmeister", "notes", "001-handoff-start.md"),
      "---\ntype: handoff\nstatus: open\n---\n# Handoff\nstart here\n",
    );
    const write = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    await notes({ action: "context" });
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

// SW-1078: a workflow template edited after init is named, not blamed on the werkmeister repo.
describe("skills check in an icm workspace from a user workflow", () => {
  let tpl: string;
  let ws: string;
  beforeEach(() => {
    tpl = path.join(home, "workflows", "review");
    fs.mkdirSync(path.join(tpl, "stages"), { recursive: true });
    fs.writeFileSync(
      path.join(tpl, "workflow.yaml"),
      "version: 1\nstages:\n  - name: triage\n    job: sort it\n    writes: out.md\n    check: read it\n",
    );
    fs.writeFileSync(
      path.join(tpl, "stages", "triage.md"),
      "One job: sort it.\n\n## Inputs\n- `../../BRIEF.md`\n\n## Do NOT load\nsource.\n\n" +
        "## Process\n1. Sort.\n\n## Outputs\n- `output/out.md`\n\n## Human check\nRead it.\n",
    );
    ws = path.join(wsRoot, "review-ws");
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".werkmeister", "workspace.yml"),
      "context_strategy: icm\nwork_type: review\n",
    );
    strategyFor(ws).init({
      workspaceRoot: ws,
      workspaceName: path.basename(ws),
      repos: [],
      task: "demo",
      meta: { FEATURE: "", SERVICES: "" },
      inputs: { context_strategy: "icm", work_type: "review" },
      configOverride: null,
    });
    vi.spyOn(process, "cwd").mockReturnValue(ws);
  });

  async function check(): Promise<{ text: string; code: number | undefined }> {
    let code: number | undefined;
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      code = c;
      throw new Error(`exit ${c}`);
    }) as never);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    await skills({ action: "check" }).catch(() => {});
    return { text: lines.join("\n"), code };
  }

  it("names the template folder after a stage file edit, not the werkmeister repo", async () => {
    fs.appendFileSync(path.join(tpl, "stages", "triage.md"), "One more line.\n");
    const { text, code } = await check();
    expect(code).toBe(1);
    expect(text).toContain(`template changed since init: ${tpl}`);
    expect(text).toContain(`Workflow template ${tpl} changed since init`);
    expect(text).not.toContain("lags the werkmeister repo");
  });

  it("still blames the werkmeister repo for ordinary drift", async () => {
    fs.writeFileSync(path.join(ws, "_shared", "standards.md"), "hand edit\n");
    const { text, code } = await check();
    expect(code).toBe(1);
    expect(text).toContain("lags the werkmeister repo");
    expect(text).not.toContain("changed since init");
  });
});

// SW-1143: services' `stages:` text renders from the live registry, so it can drift a workspace too.
describe("skills check with a service's stages: text", () => {
  const registry = (text: string) =>
    fs.writeFileSync(
      path.join(home, "services.yaml"),
      `services:\n  api:\n    stages:\n      research: "${text}"\n`,
    );
  let ws: string;
  beforeEach(() => {
    registry("List the api routes.");
    ws = path.join(wsRoot, "stages-ws");
    fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".werkmeister", "workspace.yml"),
      "context_strategy: icm\nwork_type: feature\nservices: api\n",
    );
    strategyFor(ws).init({
      workspaceRoot: ws,
      workspaceName: path.basename(ws),
      repos: [],
      task: "demo",
      meta: { FEATURE: "", SERVICES: "api" },
      inputs: { context_strategy: "icm", work_type: "feature", services: "api" },
      configOverride: null,
    });
    vi.spyOn(process, "cwd").mockReturnValue(ws);
  });

  async function check(): Promise<{ text: string; code: number | undefined }> {
    let code: number | undefined;
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      code = c;
      throw new Error(`exit ${c}`);
    }) as never);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => void lines.push(String(m)));
    const c = collectingReporter();
    await withReporter(c, () => skills({ action: "check" })).catch(() => {});
    return { text: `${c.text()}${lines.join("\n")}`, code };
  }

  it("names the registry's stages: text as a cause after it changes", async () => {
    registry("List the api routes and their auth.");
    const { text, code } = await check();
    expect(code).toBe(1);
    expect(text).toContain("stages/01_research/CONTEXT.md");
    expect(text).toContain("or a service's `stages:` text in the registry changed");
  });

  it("prints an over-long entry as [err], with no stack", async () => {
    registry("x".repeat(601));
    const { text, code } = await check();
    expect(code).toBe(1);
    expect(text).toMatch(
      /\[err\]\s+services\.yaml: service 'api' stages\.research is 601 characters \(max 600\)/,
    );
    expect(text).not.toMatch(/\n\s+at /);
  });
});
