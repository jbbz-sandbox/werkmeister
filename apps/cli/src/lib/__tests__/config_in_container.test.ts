/**
 * SW-354: a workspace container mounts the host's ~/.werkmeister read-write at
 * the same path with HOME set to the host home, so writing machine config from
 * inside one pins the host's werkmeister_root to the container path /app/apps/cli.
 * The shared writers refuse there; a relocated config (WERKMEISTER_CONFIG_FILE,
 * what every test uses) is still written.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The test may itself run inside a workspace container, so the marker file is
// faked rather than read.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return { ...real, existsSync: (p: fs.PathLike) => p === "/.dockerenv" || real.existsSync(p) };
});

import * as gc from "werkmeister-core/global_config";

const saved = {
  HOME: process.env.HOME,
  WERKMEISTER_FEATURE: process.env.WERKMEISTER_FEATURE,
  WERKMEISTER_CONFIG_FILE: process.env.WERKMEISTER_CONFIG_FILE,
};
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-container-"));
  process.env.HOME = home;
  process.env.WERKMEISTER_FEATURE = "demo";
  delete process.env.WERKMEISTER_CONFIG_FILE;
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("machine config writes inside a workspace container", () => {
  it("refuse to touch the host's ~/.werkmeister", () => {
    const cfg = { version: 1, paths: { werkmeister_root: "/app/apps/cli" } };
    expect(() => gc.save(cfg)).toThrow(expect.objectContaining({ code: "INSIDE_CONTAINER" }));
    expect(() => gc.writeEnvSh(cfg)).toThrow(expect.objectContaining({ code: "INSIDE_CONTAINER" }));
    expect(fs.existsSync(path.join(home, ".werkmeister"))).toBe(false);
  });

  it("still write a relocated config (WERKMEISTER_CONFIG_FILE)", () => {
    const cfgFile = path.join(home, "relocated", "config.yaml");
    process.env.WERKMEISTER_CONFIG_FILE = cfgFile;
    const cfg = { version: 1, paths: { werkmeister_root: "/app/apps/cli" } };
    expect(gc.save(cfg)).toBe(cfgFile);
    expect(gc.writeEnvSh(cfg)).toBe(path.join(home, "relocated", "env.sh"));
  });
});
