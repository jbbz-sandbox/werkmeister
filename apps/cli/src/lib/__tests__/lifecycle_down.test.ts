/**
 * `lifecycle.down` is library code now, so its reporter lines reach the
 * dashboard and claudeck as well as the terminal: no CLI flag names, and a
 * teardown that failed must say so rather than pass as success
 * (known-issues.md, "Library Rough Edges").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Reporter } from "sandbox-core/reporter";
import { withReporter } from "sandbox-core/reporter";

import { makeRecorder } from "../../commands/__tests__/helpers/recorder.js";

vi.mock("sandbox-core/compose", () => ({ composeDownAsync: vi.fn() }));
vi.mock("sandbox-core/slots", () => ({ getSlot: async () => 3, releaseSlot: vi.fn() }));
vi.mock("sandbox-core/telepresence", () => ({ leaveFeatureIntercepts: () => [] }));

import { composeDownAsync } from "sandbox-core/compose";
import { down } from "sandbox-core/lifecycle";

let lines: string[];
let recorder: Reporter;

beforeEach(() => {
  ({ lines, reporter: recorder } = makeRecorder());
  vi.mocked(composeDownAsync).mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("lifecycle.down", () => {
  it("names the volume removal without the CLI flag", async () => {
    await withReporter(recorder, () => down("demo", { removeVolumes: true }));

    expect(lines).toContain("[info] Per-feature Docker volumes will be removed");
    expect(lines.join("\n")).not.toContain("--volumes");
  });

  it("warns when the teardown fails, and still releases the slot", async () => {
    vi.mocked(composeDownAsync).mockResolvedValue(false);

    const result = await withReporter(recorder, () => down("demo"));

    expect(lines.some((l) => l.startsWith("[warn] Containers for 'demo' may still exist"))).toBe(true);
    expect(result).toEqual({ feature: "demo", slot: 3 });
  });
});
