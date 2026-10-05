/**
 * What `sandbox down` still does now that the teardown lives in
 * `sandbox-core/lifecycle`.
 *
 * Two of these guard decisions that would regress silently rather than loudly:
 * the proxy reloads once per *command* (which is why `reloadProxy` is a
 * separate export instead of a step inside `down`), and the workspace notes are
 * read before the containers they resolve through are removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Reporter } from "sandbox-core/reporter";
import { withReporter } from "sandbox-core/reporter";

import { makeRecorder } from "./helpers/recorder.js";

vi.mock("sandbox-core/lifecycle", () => ({
  down: vi.fn(),
  reloadProxy: vi.fn(),
  teardownNotes: vi.fn(),
}));
vi.mock("sandbox-core/slots", () => ({ getAllSlots: vi.fn() }));
vi.mock("sandbox-core/compose", () => ({ workspaceForFeature: vi.fn(() => "/ws") }));
vi.mock("sandbox-core/graduate", () => ({
  GraduationError: class extends Error {},
  reconcileGraduating: () => [],
}));
vi.mock("../notes.js", () => ({ graduateOne: vi.fn(), input: vi.fn() }));
vi.mock("../../lib/dotenv.js", () => ({ loadDotenv: () => ({}) }));

import { down as downFeature, reloadProxy, teardownNotes } from "sandbox-core/lifecycle";
import { getAllSlots } from "sandbox-core/slots";
import { run as runDown } from "../down.js";

let lines: string[];
let recorder: Reporter;

beforeEach(() => {
  ({ lines, reporter: recorder } = makeRecorder());
  // Banners, notes and the summary are `console.log`, not reporter events.
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
  vi.mocked(teardownNotes).mockResolvedValue({
    workspace: "/ws",
    handoff: null,
    decisions: [],
    graduated: [],
  });
  vi.mocked(downFeature).mockImplementation(async (feature: string) => {
    lines.push(`<down ${feature}>`);
    return { feature, slot: 3 };
  });
  vi.mocked(reloadProxy).mockImplementation(async () => {
    lines.push("<reloadProxy>");
    return { features: [], started: false, ok: true };
  });
});

afterEach(() => vi.restoreAllMocks());

const go = (args: Record<string, unknown>) => withReporter(recorder, () => runDown(args));

describe("sandbox down", () => {
  it("passes --volumes through and renders the slot the library released", async () => {
    await go({ feature: "demo", volumes: true });

    expect(downFeature).toHaveBeenCalledWith("demo", {
      removeVolumes: true,
      // The CLI is where a Ctrl-C becomes a cancellation the library can act on.
      signal: expect.any(AbortSignal),
    });
    const out = lines.join("\n");
    expect(out).toContain("Slot 3 released");
    expect(out).toContain("Per-feature Docker volumes removed");
  });

  it("omits the slot line when the feature held no slot", async () => {
    vi.mocked(downFeature).mockResolvedValue({ feature: "demo", slot: null });

    await go({ feature: "demo" });

    expect(lines.join("\n")).not.toContain("Slot");
  });

  it("reads the workspace notes before the teardown removes the containers", async () => {
    vi.mocked(teardownNotes).mockImplementation(async () => {
      lines.push("<teardownNotes demo>");
      return {
        workspace: "/ws",
        handoff: {
          path: "/ws/.sandbox/notes/001-handoff-x.md",
          number: 1,
          type: "handoff",
          slug: "x",
          frontmatter: {},
          body: "the handoff body",
        },
        decisions: [],
        graduated: [],
      };
    });

    await go({ feature: "demo" });

    // The read must precede the teardown: teardownNotes resolves the workspace
    // through compose labels on the feature's still-running containers.
    expect(lines.indexOf("<teardownNotes demo>")).toBeLessThan(lines.indexOf("<down demo>"));

    const handoff = lines.findIndex((l) => l.includes("the handoff body"));
    expect(handoff).toBeGreaterThan(-1);
    expect(handoff).toBeLessThan(lines.indexOf("<down demo>"));
  });

  it("reloads the proxy once for --all-features, not once per feature", async () => {
    vi.mocked(getAllSlots).mockResolvedValue({ a: { slot: 1 }, b: { slot: 2 } } as never);

    await go({ all_features: true });

    expect(downFeature).toHaveBeenCalledTimes(2);
    expect(reloadProxy).toHaveBeenCalledTimes(1);
    // and only after every feature is down, so the Caddyfile is regenerated once
    expect(lines.indexOf("<reloadProxy>")).toBeGreaterThan(lines.indexOf("<down b>"));
  });

  it("does nothing when --all-features finds no active features", async () => {
    vi.mocked(getAllSlots).mockResolvedValue({} as never);

    await go({ all_features: true });

    expect(downFeature).not.toHaveBeenCalled();
    expect(reloadProxy).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("No active features to stop.");
  });
});
