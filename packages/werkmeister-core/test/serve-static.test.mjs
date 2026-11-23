// SW-963: `workspace serve <dir>` is pre-approved for every ICM run, so it serves only a folder
// whose realpath is inside the workspace, and only on loopback at an ephemeral port.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { staticServer } from "../dist/serve_static.js";

const LINE = ["python3", "-I", "-u", "-m", "http.server", "0", "-b", "127.0.0.1", "-d"];

function tree() {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "serve-static-")));
  const ws = path.join(top, "ws");
  fs.mkdirSync(path.join(ws, "stages", "03_exercise", "output"), { recursive: true });
  fs.mkdirSync(path.join(top, "other", "stages"), { recursive: true });
  fs.writeFileSync(path.join(ws, "file.html"), "<p>x</p>");
  fs.symlinkSync(path.join(top, "other"), path.join(ws, "link-out"));
  fs.symlinkSync(path.join(ws, "stages"), path.join(ws, "link-in"));
  return { top, ws };
}

test("serves a folder inside the workspace, relative or absolute", () => {
  const { ws } = tree();
  for (const [dir, cwd, served] of [
    ["stages", ws, path.join(ws, "stages")],
    ["output", path.join(ws, "stages", "03_exercise"), path.join(ws, "stages/03_exercise/output")],
    [path.join(ws, "stages"), "/", path.join(ws, "stages")],
    ["link-in", ws, path.join(ws, "stages")],
  ])
    assert.deepEqual(staticServer(ws, dir, cwd), { argv: [...LINE, served] }, dir);
});

test("refuses a folder outside the workspace, by .., symlink or a sibling with the same prefix", () => {
  const { top, ws } = tree();
  fs.mkdirSync(`${ws}-other`);
  for (const dir of ["..", "../other/stages", "link-out", `${ws}-other`, "/", os.homedir()]) {
    const r = staticServer(ws, dir, ws);
    assert.match(r.error ?? "", /outside the workspace/, dir);
  }
  assert.ok(fs.existsSync(path.join(top, "other")));
});

test("refuses the workspace folder itself and dot-folders, which hold its token and .env files", () => {
  const { ws } = tree();
  fs.mkdirSync(path.join(ws, ".werkmeister", "bin"), { recursive: true });
  fs.mkdirSync(path.join(ws, "stages", ".hidden"));
  for (const dir of [".", ws, "stages/..", ".werkmeister", ".werkmeister/bin", "stages/.hidden"])
    assert.match(
      staticServer(ws, dir, ws).error ?? "",
      /workspace folder itself or a dot-folder/,
      dir,
    );
});

test("refuses a missing folder, a file, and a cwd outside any workspace", () => {
  const { ws } = tree();
  assert.match(staticServer(ws, "nope", ws).error, /does not exist/);
  assert.match(staticServer(ws, "file.html", ws).error, /is not a directory/);
  assert.match(staticServer(null, "stages", ws).error, /Not inside a workspace/);
});
