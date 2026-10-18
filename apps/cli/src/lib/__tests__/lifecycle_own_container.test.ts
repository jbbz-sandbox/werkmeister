/**
 * A lifecycle verb run inside the very container it is about to recreate,
 * stop or remove kills itself mid-sequence (exit 137) — #198. It refuses
 * before touching compose or the shared infra.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSE_FILE } from "werkmeister-core/compose_file";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

const { composeUpAsync, ensurePortForwardsHealthy } = vi.hoisted(() => ({
  composeUpAsync: vi.fn(async () => true),
  ensurePortForwardsHealthy: vi.fn(() => "healthy"),
}));

// The test may itself run inside a workspace container, so the marker file is
// faked rather than read.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, existsSync: (p: fs.PathLike) => p === "/.dockerenv" || real.existsSync(p) };
});
vi.mock("werkmeister-core/compose", () => ({ composeUpAsync }));
vi.mock("werkmeister-core/k8s", () => ({ ensurePortForwardsHealthy }));

import { insideOwnContainer, up } from "werkmeister-core/lifecycle";

const quiet: Reporter = { passthrough: false, emit: () => {} };
let root: string;
const saved = process.env.SANDBOX_FEATURE;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "up-own-container-"));
  fs.writeFileSync(path.join(root, COMPOSE_FILE), "services: {}\n");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.SANDBOX_FEATURE;
  else process.env.SANDBOX_FEATURE = saved;
});

describe("insideOwnContainer", () => {
  it("is true only in a container whose SANDBOX_FEATURE is the target", () => {
    expect(insideOwnContainer("demo", { SANDBOX_FEATURE: "demo" })).toBe(true);
    expect(insideOwnContainer("demo", { SANDBOX_FEATURE: "other" })).toBe(false);
    expect(insideOwnContainer("demo", {})).toBe(false);
    expect(
      insideOwnContainer(
        "demo",
        { SANDBOX_FEATURE: "demo" },
        path.join(os.tmpdir(), "no-such-dockerenv"),
      ),
    ).toBe(false);
  });
});

describe("lifecycle.up inside the feature's own container", () => {
  it("refuses before checking forwards or running compose", async () => {
    process.env.SANDBOX_FEATURE = "demo";
    await expect(withReporter(quiet, () => up("demo", root))).rejects.toMatchObject({
      code: "INSIDE_OWN_CONTAINER",
    });
    expect(ensurePortForwardsHealthy).not.toHaveBeenCalled();
    expect(composeUpAsync).not.toHaveBeenCalled();
  });
});
