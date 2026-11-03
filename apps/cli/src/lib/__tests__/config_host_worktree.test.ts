/**
 * SW-363: werkmeister_root is self-derived from the running checkout, so a
 * branch-built CLI run on the host (a test without with-temp-home, a worktree's
 * `machine config`) used to record its own worktree in the host's config.yaml and
 * env.sh. The shared writers keep the stored value unless the running checkout is
 * the installed `werkmeister` (the one on PATH).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as gc from "werkmeister-core/global_config";
import * as YAML from "yaml";

const saved = {
  PATH: process.env.PATH,
  WERKMEISTER_CONFIG_FILE: process.env.WERKMEISTER_CONFIG_FILE,
};
let tmp: string;
let cfgFile: string;

const root = () => YAML.parse(fs.readFileSync(cfgFile, "utf8")).paths.werkmeister_root;

beforeEach(() => {
  // realpath: macOS gives /var/… for a /private/var/… folder.
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-host-")));
  cfgFile = path.join(tmp, "config.yaml");
  process.env.WERKMEISTER_CONFIG_FILE = cfgFile;
  // A PATH with no `werkmeister`: the running checkout is not the installed one.
  fs.mkdirSync(path.join(tmp, "bin"));
  process.env.PATH = path.join(tmp, "bin");
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("werkmeister_root written from a checkout that is not the installed CLI", () => {
  it("keeps the stored value in config.yaml and env.sh", () => {
    gc.save({ version: 1, paths: { werkmeister_root: "/installed/apps/cli", repos_root: "/r" } });
    const cfg = { version: 1, paths: { werkmeister_root: "/worktree/apps/cli", repos_root: "/r" } };
    gc.save(cfg);
    expect(root()).toBe("/installed/apps/cli");
    gc.writeEnvSh(cfg);
    expect(fs.readFileSync(path.join(tmp, "env.sh"), "utf8")).toContain(
      "export WERKMEISTER_ROOT=/installed/apps/cli",
    );
  });

  it("writes it when the running checkout is the werkmeister on PATH", () => {
    const installed = path.join(tmp, "inst", "apps", "cli");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "werkmeister"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync(path.join(installed, "werkmeister"), path.join(tmp, "bin", "werkmeister"));
    gc.save({ version: 1, paths: { werkmeister_root: "/old/apps/cli" } });
    gc.save({ version: 1, paths: { werkmeister_root: installed } });
    expect(root()).toBe(installed);
  });
});
