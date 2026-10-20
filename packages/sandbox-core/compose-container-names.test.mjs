// SW-36: the built-in compose fallback named containers `sandbox-<feature>-<svc>`
// while the Nunjucks template names them `<feature>-<svc>`. Every consumer (the PR
// gate's containerFor, generated `docker restart` lines, allow rules, the logs
// guard, stats) looks up `<feature>-<svc>`, so fallback-generated workspaces had
// containers nothing could find.
//
// Renders the same feature through both paths. The template path uses the real
// apps/cli checkout; the fallback path points SANDBOX_ROOT at an empty dir so
// the template lookup misses.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "./dist/generate.js";
import { withSandboxHome } from "./fixtures.mjs";

const FEATURE = "demo-feature";
const SERVICES = ["backend", "frontend"];

function containerNames(sandboxRoot) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cn-ws-"));
  const prev = process.env.SANDBOX_ROOT;
  if (sandboxRoot) process.env.SANDBOX_ROOT = sandboxRoot;
  try {
    return withSandboxHome(async () => {
      const out = generateFeatureCompose(FEATURE, 1, SERVICES, null, ws);
      const compose = YAML.parse(fs.readFileSync(out, "utf8"));
      return Object.fromEntries(
        Object.entries(compose.services).map(([svc, def]) => [svc, def.container_name]),
      );
    });
  } finally {
    if (prev === undefined) delete process.env.SANDBOX_ROOT;
    else process.env.SANDBOX_ROOT = prev;
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("the built-in fallback names containers <feature>-<svc>, like the template", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-cn-root-"));
  try {
    const template = await containerNames(null);
    const fallback = await containerNames(empty);
    assert.deepEqual(template, {
      backend: `${FEATURE}-backend`,
      frontend: `${FEATURE}-frontend`,
    });
    assert.deepEqual(fallback, template);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});
