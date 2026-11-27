// SW-876: importing the harness layer (which loads harness/codex/cli.ts) must not touch
// node:child_process at load, so a test that mocks it without execFile still imports it.
import { expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

it("imports harness_layout under a spawn-only child_process mock", async () => {
  await expect(import("werkmeister-core/harness_layout")).resolves.toHaveProperty("harnessFor");
});
