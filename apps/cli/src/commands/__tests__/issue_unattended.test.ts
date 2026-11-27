import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";

import { unattendedCreateRefusal } from "../issue.js";

// SW-815: the pre-approved `issue create --relates <own issue>:*` posts only a workspace file, in its own project.
function workspace(yml: string) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "issue-unattended-")));
  fs.mkdirSync(path.join(ws, ".werkmeister"));
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), yml);
  fs.writeFileSync(path.join(ws, "followup.md"), "body\n");
  return ws;
}

it("an autonomous workspace files a workspace file in its own issue's project, nothing else", () => {
  const ws = workspace("autonomous: true\nissue_id: SW-855\n");
  const outside = path.join(os.tmpdir(), `issue-unattended-secret-${process.pid}`);
  fs.writeFileSync(outside, "token\n");
  fs.symlinkSync(outside, path.join(ws, "link.md"));
  const args = (project: string, bodyFile: string) => ({ project, bodyFile });
  expect(unattendedCreateRefusal(args("sw", path.join(ws, "followup.md")), ws)).toBeNull();
  expect(unattendedCreateRefusal(args("OTHER", path.join(ws, "followup.md")), ws)).toMatch(
    /own issue's project \(SW\)/,
  );
  for (const bodyFile of ["-", outside, path.join(ws, "link.md"), path.join(ws, "missing.md")])
    expect(unattendedCreateRefusal(args("SW", bodyFile), ws)).toMatch(/inside the workspace/);
  fs.rmSync(outside);
});

it("SW-1036: stdin is refused in an autonomous workspace, and the help says so", () => {
  const ws = workspace("autonomous: true\nissue_id: SW-855\n");
  expect(unattendedCreateRefusal({ project: "SW", bodyFile: "-" }, ws)).toMatch(
    /Stdin is refused here: write the body to a file in the workspace/,
  );
  const main = fs.readFileSync(path.join(import.meta.dirname, "..", "..", "main.ts"), "utf8");
  expect(main).toContain("(- for stdin, except in an autonomous workspace)");
});

it("a person's workspace, or no workspace, is not limited", () => {
  const args = { project: "OTHER", bodyFile: "-" };
  expect(unattendedCreateRefusal(args, workspace("issue_id: SW-855\n"))).toBeNull();
  expect(unattendedCreateRefusal(args, null)).toBeNull();
});
