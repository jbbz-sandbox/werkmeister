import { afterEach, expect, it, vi } from "vitest";

// The health list only counts containers that exist: with k8s-forwards never
// built, Caddy alone read "All 1 services healthy" and connect exited 0.
vi.mock("werkmeister-core/infra", () => ({
  up: async () => false,
  infraHealth: async () => ({ caddy: true }),
  connectK8s: async () => true,
}));
vi.mock("werkmeister-core/issue_tracker", () => ({
  ghBin: () => "gh",
  issueTracker: () => ({ id: "jira", label: "Jira", checkAuth: async () => ({ ok: true }) }),
}));
vi.mock("werkmeister-core/web_servers", () => ({
  DASHBOARD: { name: "dashboard" },
  MCP: { name: "mcp" },
  status: () => ({ running: true }),
}));
const { run } = await import("../connect.js");

afterEach(() => {
  process.exitCode = undefined;
});

it("a failed shared-infra start says so and exits non-zero, even when what exists is healthy", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await run({});
  const out = log.mock.calls.map((c) => String(c[0])).join("\n");
  log.mockRestore();
  expect(out).toContain("Shared infrastructure did not start");
  expect(out).not.toContain("All 1 services healthy");
  expect(process.exitCode).toBe(1);
});
