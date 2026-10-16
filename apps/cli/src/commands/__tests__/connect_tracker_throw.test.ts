import { expect, it, vi } from "vitest";

vi.mock("sandbox-core/issue_tracker", () => ({
  ghBin: () => "gh",
  issueTracker: () => ({
    id: "jira",
    label: "Jira",
    checkAuth: async () => {
      throw new Error("config unreadable");
    },
  }),
}));
const { checkTracker } = await import("../connect.js");

it("a throwing tracker check prints one line and never fails connect", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await expect(checkTracker()).resolves.toBeUndefined();
  expect(log.mock.calls.map((c) => String(c[0]))).toEqual([
    expect.stringContaining("issue tracker · Jira · check failed: config unreadable"),
  ]);
  log.mockRestore();
});
