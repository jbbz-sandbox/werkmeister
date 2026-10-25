import { afterEach, expect, it, vi } from "vitest";

// SW-76: jaeger and redisinsight are opt-in, so connect links only the ones
// that came up and says how to turn the rest on.
const infra = vi.hoisted(() => ({ health: {} as Record<string, boolean> }));
vi.mock("werkmeister-core/infra", () => ({
  up: async () => true,
  infraHealth: async () => infra.health,
  connectK8s: async () => true,
}));
vi.mock("werkmeister-core/global_config", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/global_config")>()),
  loadIngress: () => ({ local_domain: "local.example.test" }),
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

async function output(health: Record<string, boolean>): Promise<string> {
  infra.health = health;
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await run({});
  const out = log.mock.calls.map((c) => String(c[0])).join("\n");
  log.mockRestore();
  return out;
}

it("with neither running, links neither and names both as off", async () => {
  const out = await output({ caddy: true, "k8s-forwards": true });
  expect(out).not.toContain("tools.local.example.test/redisinsight");
  expect(out).not.toContain("tools.local.example.test/jaeger");
  expect(out).toContain("RedisInsight, Jaeger: off — add to infra.profiles");
});

it("links each one that is running and names only the rest", async () => {
  const out = await output({ caddy: true, redisinsight: true });
  expect(out).toContain("tools.local.example.test/redisinsight");
  expect(out).not.toContain("tools.local.example.test/jaeger");
  expect(out).toContain("Jaeger: off");
  expect(out).not.toContain("RedisInsight, Jaeger: off");
});

it("with both running, prints no off line", async () => {
  const out = await output({ caddy: true, redisinsight: true, jaeger: true });
  expect(out).toContain("tools.local.example.test/jaeger");
  expect(out).not.toContain(": off —");
});
