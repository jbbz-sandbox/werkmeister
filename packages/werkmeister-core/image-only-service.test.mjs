// SW-230: a services.yaml service with `image:` and no `repo:` is accepted and
// renders like an app service, minus the repo mount, so a fixture can run a real up.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import YAML from "yaml";

import { generateFeatureCompose } from "./dist/generate.js";
import { resolveRepos } from "./dist/worktrees.js";
import { pinWerkmeisterRoot, withSandboxHome } from "./fixtures.mjs";

pinWerkmeisterRoot();

test("resolveRepos accepts an image-only service and rejects one with neither repo nor image", () => {
  const services = {
    web: { image: "nginx:alpine" },
    api: { repo: "backend" },
    bad: { port_offset: 1 },
  };
  assert.deepEqual(resolveRepos(null, "web", services), [[], ["web"], []]);
  assert.deepEqual(resolveRepos(null, "web,api", services), [["backend"], ["web", "api"], []]);
  assert.deepEqual(resolveRepos(null, "bad,missing", services)[2], ["bad", "missing"]);
});

function render(web) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-img-ws-"));
  try {
    return withSandboxHome(async () => {
      const file = generateFeatureCompose("f", 1, ["web"], { services: { web } }, ws);
      return YAML.parse(fs.readFileSync(file, "utf8")).services.web;
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("an image-only service renders its image, port and command, with no build or mount", async () => {
  const web = await render({
    image: "nginx:alpine",
    internal_port: 80,
    port_offset: 0,
    command: "nginx -g 'daemon off;'",
  });
  assert.equal(web.image, "nginx:alpine");
  assert.equal(web.ports.length, 1);
  assert.match(web.ports[0], /^\d+:80$/);
  assert.deepEqual(web.command, ["/bin/sh", "-c", "nginx -g 'daemon off;'\n"]);
  assert.equal(web.labels["com.werkmeister.role"], "app");
  for (const key of ["build", "volumes", "working_dir"]) assert.equal(web[key], undefined, key);
});

test("an image-only service with no command keeps the image's CMD", async () => {
  const web = await render({ image: "nginx:alpine", internal_port: 80 });
  assert.equal(web.command, undefined);
});
