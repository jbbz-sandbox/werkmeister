import { describe, expect, it } from "vitest";

import { updateFromArgs } from "../issue.js";

describe("sandbox issue update arguments", () => {
  it("rejects an update with neither --status nor --comment", () => {
    expect(updateFromArgs({ status: null, comment: null })).toMatch(/--status.*--comment/);
  });

  it("passes either field through", () => {
    expect(updateFromArgs({ status: "In Development", comment: null })).toEqual({ status: "In Development", comment: undefined });
    expect(updateFromArgs({ status: null, comment: "hi" })).toEqual({ status: undefined, comment: "hi" });
  });
});
