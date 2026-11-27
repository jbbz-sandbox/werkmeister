/**
 * getVolumeBaseNames() — the suffix set `sandbox clean` uses to recognise
 * per-feature Docker volumes (`<feature>-<base>`). Each test stages a synthetic
 * services.yaml in a throwaway ~/.sandbox, so the assertions pin the derivation
 * rather than whatever registry the developer happens to have.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getVolumeBaseNames } from "../config.js";
import { type SandboxHome, useSandboxHome } from "./helpers/sandbox_home.js";

let home: SandboxHome;

beforeEach(() => {
  // fixtures: [] — every test writes the registry it wants (or none at all).
  home = useSandboxHome({ fixtures: [] });
});

afterEach(() => {
  home.cleanup();
});

function writeServices(body: string): void {
  home.write("services.yaml", body);
}

describe("getVolumeBaseNames", () => {
  it("collects node_modules_volume and named extra_volumes from services and setup_services", () => {
    writeServices(`
services:
  web:
    node_modules_volume: web_node_modules
    extra_volumes:
      - web_turbo_cache:/app/.turbo
  api:
    node_modules_volume: api_node_modules
setup_services:
  install:
    node_modules_volume: shared_node_modules
    extra_volumes:
      - shared_nx:/app/.nx
`);
    expect(getVolumeBaseNames()).toEqual([
      "api_node_modules",
      "shared_node_modules",
      "shared_nx",
      "web_node_modules",
      "web_turbo_cache",
    ]);
  });

  it("adds the repo-scoped name a clash between repos uses (SW-110)", () => {
    writeServices(`
services:
  web:
    repo: shop
    node_modules_volume: node-modules
`);
    expect(getVolumeBaseNames()).toEqual(["node-modules", "shop-node-modules"]);
  });

  it("skips bind mounts, null volumes and duplicates", () => {
    writeServices(`
services:
  web:
    node_modules_volume: null
    extra_volumes:
      - \${REPO}/.git:/app/.git:ro
      - shared_cache:/app/.cache
  api:
    extra_volumes:
      - shared_cache:/app/.cache
`);
    expect(getVolumeBaseNames()).toEqual(["shared_cache"]);
  });

  // SW-1234: a sidecar's data volume is `<feature>-<name>` too, so `clean` must know its base.
  it("collects the named extra_volumes of extra_services sidecars", () => {
    writeServices(`
services:
  api:
    node_modules_volume: null
    extra_services:
      api-db:
        image: postgres:16
        extra_volumes:
          - pgdata:/var/lib/postgresql/data
          - ^shared_dump:/dump
`);
    expect(getVolumeBaseNames()).toEqual(["pgdata"]);
  });

  it("returns an empty list for a registry that declares no volumes", () => {
    writeServices(`
services:
  web:
    node_modules_volume: null
setup_services: {}
`);
    expect(getVolumeBaseNames()).toEqual([]);
  });

  it("throws when the registry is missing (clean skips volume cleanup)", () => {
    expect(() => getVolumeBaseNames()).toThrow();
  });
});
