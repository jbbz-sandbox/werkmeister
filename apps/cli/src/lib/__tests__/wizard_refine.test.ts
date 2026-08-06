/** offerRefine — the wizard's "Refine with Claude? [y/N]" offer. */
import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain function, not vi.fn(): vitest reports a throwing vi.fn() behind a
// mocked module as a test failure even when the caller catches it, which is
// exactly the fallback this suite has to cover. Calls are recorded by hand.
let refine: (...args: unknown[]) => Promise<string> | string;
const calls: unknown[][] = [];
vi.mock("sandbox-driver", () => ({
  refinePrompt: (...args: unknown[]) => {
    calls.push(args);
    return refine(...args);
  },
}));

const { offerRefine } = await import("../wizard.js");

const SPEC = { key: "starting_prompt", label: "Starting prompt", help: "h", refinable: true,
               refineInstruction: "Rewrite as a dev instruction." };

/** An `ask` that replays scripted answers in order. */
function asking(...answers: string[]) {
  let i = 0;
  return async () => answers[i++] ?? "";
}

describe("offerRefine", () => {
  beforeEach(() => {
    calls.length = 0;
    refine = async () => "rewritten";
  });

  it("declining leaves the text untouched and never calls Claude", async () => {
    for (const answer of ["", "n", "no", "nope"]) {
      expect(await offerRefine(SPEC, "draft", {}, asking(answer))).toBe("draft");
    }
    expect(calls).toHaveLength(0);
  });

  it("accepting passes the spec's instruction and answers so far, then keeps the rewrite", async () => {
    refine = async () => "  Goal: ship it.  ";
    const context = { feature: "mdx-blog" };
    expect(await offerRefine(SPEC, "draft", context, asking("y", ""))).toBe("Goal: ship it.");
    expect(calls).toEqual([["draft", SPEC.refineInstruction, context]]);
  });

  it("rejecting the rewrite restores the original", async () => {
    expect(await offerRefine(SPEC, "draft", {}, asking("yes", "n"))).toBe("draft");
  });

  it("an empty rewrite or a failed refine never costs the user their text", async () => {
    refine = async () => "   ";
    expect(await offerRefine(SPEC, "draft", {}, asking("y", ""))).toBe("draft");
    refine = () => {
      throw new Error("claude not found");
    };
    expect(await offerRefine(SPEC, "draft", {}, asking("y", ""))).toBe("draft");
  });
});
