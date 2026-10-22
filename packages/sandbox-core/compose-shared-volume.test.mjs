// A `^name` extra_volumes entry is one Docker volume every feature shares (a
// pnpm store, say), where a bare name is `<feature>-<name>`. Two things must
// hold: every feature's compose mounts the same unprefixed volume, and no
// feature's teardown removes it. Compose's `down --volumes` deletes every
// non-external volume a project declares, so it must be `external`; and
// `sandbox clean` deletes what matches a per-feature base name, so it must not
// be one.
//
// Renders through both the template and the built-in fallback, like
// compose-container-names.test.mjs: SANDBOX_ROOT at an empty dir misses the
// template. The template case pins this checkout's apps/cli, not whatever
// install a developer's own SANDBOX_ROOT points at.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { getSharedVolumeNames, getVolumeBaseNames } from "./dist/config.js";
import { generateFeatureCompose } from "./dist/generate.js";
import { featureFromVolume, volumeBaseNames } from "./dist/lifecycle.js";
import { withSandboxHome } from "./fixtures.mjs";

const CLI_ROOT = path.resolve(import.meta.dirname, "../../apps/cli");

const SERVICES = `services:
  backend:
    type: api
    repo: demo-repo
    port_offset: 2
    setup_service: demo-install
    node_modules_volume: node-modules
    extra_volumes:
      - ^sandbox-pnpm-store:/pnpm-store
      - turbo-cache:/app/.turbo
setup_services:
  demo-install:
    repo: demo-repo
    image: node:22-alpine
    command: "pnpm install"
    node_modules_volume: node-modules
    extra_volumes:
      - ^sandbox-pnpm-store:/pnpm-store
`;

/** Generate *feature*'s compose under *sandboxRoot* and parse it. */
function compose(feature, sandboxRoot) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-sv-ws-"));
  const prev = process.env.SANDBOX_ROOT;
  process.env.SANDBOX_ROOT = sandboxRoot;
  try {
    return YAML.parse(
      fs.readFileSync(generateFeatureCompose(feature, 1, ["backend"], null, ws), "utf8"),
    );
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_ROOT;
    else process.env.SANDBOX_ROOT = prev;
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("two features mount one external shared volume, each keeping its own per-feature ones", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-sv-root-"));
  try {
    await withSandboxHome(
      async () => {
        // The fallback renders no setup containers (see its ponytail note), so only the app is checked there.
        for (const [kind, root, services] of [
          ["template", CLI_ROOT, ["backend", "demo-install"]],
          ["fallback", empty, ["backend"]],
        ]) {
          const a = compose("alpha", root);
          const b = compose("beta", root);
          for (const [feature, doc] of [
            ["alpha", a],
            ["beta", b],
          ]) {
            assert.deepEqual(
              doc.volumes["sandbox-pnpm-store"],
              { name: "sandbox-pnpm-store", external: true },
              `${kind}: ${feature} declares the shared volume external`,
            );
            assert.deepEqual(
              doc.volumes[`${feature}-turbo-cache`],
              { name: `${feature}-turbo-cache` },
              kind,
            );
            for (const svc of services) {
              assert.ok(
                doc.services[svc].volumes.includes("sandbox-pnpm-store:/pnpm-store"),
                `${kind}: ${feature}/${svc} mounts the shared volume unprefixed`,
              );
            }
          }
        }
      },
      { services: SERVICES },
    );
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test("a shared volume is never a per-feature base name, so clean never claims it", async () => {
  await withSandboxHome(
    async () => {
      assert.deepEqual(getSharedVolumeNames(), ["sandbox-pnpm-store"]);
      assert.deepEqual(getVolumeBaseNames(), ["node-modules", "turbo-cache"]);
      assert.equal(featureFromVolume("sandbox-pnpm-store", volumeBaseNames()), null);
    },
    { services: SERVICES },
  );
});
