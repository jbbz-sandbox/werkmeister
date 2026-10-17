import { expect, it } from "vitest";

const { trackerLine } = await import("../connect.js");

it("formats the tracker line", () => {
  expect(trackerLine("GitHub", { ok: true, who: "octo", fix: "" })).toContain(
    "issue tracker · GitHub · ok (octo)",
  );
  expect(
    trackerLine("GitHub", { ok: false, reason: "not signed in", fix: "gh auth login" }),
  ).toMatch(/issue tracker · GitHub · not signed in — run: gh auth login/);
});
