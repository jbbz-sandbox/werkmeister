import { describe, expect, it } from "vitest";

import { newIssueFromArgs, updateFromArgs } from "../issue.js";

describe("sandbox issue update arguments", () => {
  it("rejects an update with neither --status nor --comment", () => {
    expect(updateFromArgs({ status: null, comment: null })).toMatch(/--status.*--comment/);
  });

  it("passes either field through", () => {
    expect(updateFromArgs({ status: "In Development", comment: null })).toEqual({
      status: "In Development",
      comment: undefined,
    });
    expect(updateFromArgs({ status: null, comment: "hi" })).toEqual({
      status: undefined,
      comment: "hi",
    });
  });
});

describe("sandbox issue create arguments", () => {
  const args = { project: "sw", type: "bug", title: " Broken ", bodyFile: "body.md" };
  const read = (p: string | 0) => (p === 0 ? "from stdin" : `read ${p}`);

  it("upper-cases the project, trims the title and reads the body file", () => {
    expect(newIssueFromArgs(args, read)).toEqual({
      project: "SW",
      type: "bug",
      title: "Broken",
      body: "read body.md",
    });
    expect(newIssueFromArgs({ ...args, bodyFile: "-" }, read)).toMatchObject({
      body: "from stdin",
    });
  });

  it("names the missing or bad argument", () => {
    expect(newIssueFromArgs({ ...args, project: null }, read)).toMatch(/--project/);
    expect(newIssueFromArgs({ ...args, type: "story" }, read)).toMatch(/--type bug\|feature\|task/);
    expect(newIssueFromArgs({ ...args, title: " " }, read)).toMatch(/--title/);
    expect(newIssueFromArgs({ ...args, bodyFile: null }, read)).toMatch(/--body-file/);
    const missing = () => {
      throw new Error("ENOENT");
    };
    expect(newIssueFromArgs(args, missing)).toMatch(/Could not read --body-file body.md: ENOENT/);
  });
});
