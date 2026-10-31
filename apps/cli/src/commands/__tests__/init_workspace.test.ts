/** `workspace init --no-build` reaches core as `build: false`; without it the build stays on (SW-216). */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/workspace_init", () => ({
  initWorkspace: vi.fn(async () => undefined),
  WorkspaceInitError: class extends Error {},
  WorkspaceRootError: class extends Error {},
}));

import { initWorkspace } from "werkmeister-core/workspace_init";
import { run } from "../init_workspace.js";

beforeEach(() => vi.mocked(initWorkspace).mockClear());

describe("init_workspace run", () => {
  it("passes build: false for --no-build", async () => {
    await run({ build: false });
    expect(vi.mocked(initWorkspace).mock.calls[0]?.[2]).toMatchObject({ build: false });
  });

  it("builds by default", async () => {
    await run({ build: true });
    expect(vi.mocked(initWorkspace).mock.calls[0]?.[2]).toMatchObject({ build: true });
  });
});
