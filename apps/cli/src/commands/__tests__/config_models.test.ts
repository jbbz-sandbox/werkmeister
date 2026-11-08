/**
 * `machine config` prints the model tiers (SW-577): the merged map per harness,
 * a value from config.yaml marked (YAML), and a harness with none named by its key.
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const cfg = { models: { default_tier: "mid", claude: { mid: "claude-sonnet-5-5" } } };
vi.mock("werkmeister-core/global_config", () => ({
  load: () => cfg,
  configPath: () => "/h/config.yaml",
  envShPath: () => "/h/env.sh",
  builtinPathDefault: (k: string) => `/default/${k}`,
  loadIngress: () => ({}),
  redactedYaml: () => "",
}));

import { run } from "../config.js";

let out: string;
beforeEach(() => {
  out = "";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += `${a.join(" ")}\n`;
  });
});
afterEach(() => vi.restoreAllMocks());

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the ANSI colours the command prints
const plain = () => out.replace(/\x1b\[[0-9;]*m/g, "");

it("prints the default tier and each harness's merged tiers", async () => {
  await run({});
  expect(plain()).toContain("models:  default tier: mid (YAML)");
  expect(plain()).toContain(
    "  claude: small=haiku mid=claude-sonnet-5-5 (YAML) frontier=opus advanced_frontier=claude-fable-5-1",
  );
  expect(plain()).toContain("  opencode: small=anthropic/claude-haiku-5-5");
  expect(plain()).toContain("  codex: (none: set models.codex.<tier>)");
});
