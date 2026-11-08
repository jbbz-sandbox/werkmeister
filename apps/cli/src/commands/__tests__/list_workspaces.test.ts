/** `workspace list` shows the model each workspace runs (SW-577), `--` for one that records none. */

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core", () => ({
  listWorkspaces: async () => ({
    root: "/ws",
    workspaces: [
      { name: "sw-1-a", issueId: "SW-1", labels: ["focus"], model: "opus" },
      { name: "old", issueId: null, labels: [], model: null },
    ],
  }),
}));

import { run } from "../list_workspaces.js";

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

it("has a Model column", async () => {
  await run({});
  expect(plain()).toMatch(/Workspace\s+Issue\s+Model\s+Labels/);
  expect(plain()).toMatch(/sw-1-a\s+SW-1\s+opus\s+focus/);
  expect(plain()).toMatch(/old\s+--\s+--\s*$/m);
});
