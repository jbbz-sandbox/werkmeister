// package.json → command, test, type/archetype and a fallback image.

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectPackages, detectWorkspace } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

function run(files, name) {
  const ctx = ctxFor(fixture(files, name));
  return detectPackages(ctx, detectWorkspace(ctx));
}

test("a turbo monorepo: one finding per workspace package", () => {
  const found = run(
    {
      "package.json": { workspaces: ["apps/*"], engines: { node: ">=20" } },
      "apps/backend/package.json": {
        name: "backend",
        scripts: { dev: "node server.js", start: "node server.js", test: "vitest run" },
        dependencies: { pg: "^8" },
      },
      "apps/frontend/package.json": {
        name: "frontend",
        scripts: { dev: "next dev", test: "vitest run" },
        dependencies: { next: "15" },
      },
    },
    "demo-services",
  );
  assert.deepEqual(
    found.map((f) => [f.name, f.dir]),
    [
      ["backend", "apps/backend"],
      ["frontend", "apps/frontend"],
    ],
  );
  const [backend, frontend] = found;
  assert.equal(backend.fields.command.value, "cd apps/backend && exec npm run dev");
  assert.equal(backend.fields.test.value, "npm test -w backend");
  assert.equal(backend.fields.type.value, "api");
  assert.equal(backend.fields.type.confidence, "guessed");
  assert.equal(backend.fields.image.value, "node:20-alpine");
  assert.equal(backend.fields.setup_service.value, "demo-services-install");
  assert.equal(backend.runnable, true);
  assert.equal(frontend.fields.type.value, "web");
  assert.equal(frontend.fields.archetype.value, "node-web");
  assert.equal(frontend.fields.type.confidence, "stated");
});

test("a single-package repo is one service at the root, named after the repo", () => {
  const [svc] = run(
    {
      "package.json": {
        name: "shop",
        scripts: { start: "node index.js", test: "node --test" },
        dependencies: { express: "4" },
      },
    },
    "shop",
  );
  assert.equal(svc.name, "shop");
  assert.equal(svc.dir, ".");
  assert.equal(svc.fields.command.value, "exec npm run start");
  assert.equal(svc.fields.test.value, "npm test");
  assert.equal(svc.fields.archetype.value, "node-service");
});

test("a glibc-only dependency drops -alpine; .nvmrc sets the major", () => {
  const [svc] = run({
    "package.json": { name: "img", dependencies: { sharp: "0.33" } },
    ".nvmrc": "v24.1.0\n",
  });
  assert.equal(svc.fields.image.value, "node:24");
  assert.match(svc.fields.image.source, /sharp/);
});

test("a package with no name still gets a usable test command", () => {
  const found = run({
    "package.json": { workspaces: ["apps/*"] },
    "apps/x/package.json": { scripts: { test: "vitest" } },
  });
  assert.equal(found[0].fields.test.value, "npm test -w apps/x");

  const pnpm = run({
    "package.json": {},
    "pnpm-workspace.yaml": "packages: ['apps/*']\n",
    "apps/x/package.json": { scripts: { test: "vitest" } },
  });
  assert.equal(pnpm[0].fields.test.value, "pnpm --filter ./apps/x test");

  const yarn = run({
    "package.json": { workspaces: ["apps/*"] },
    "yarn.lock": "",
    "apps/x/package.json": { scripts: { test: "vitest" } },
  });
  assert.equal(yarn[0].fields.test.value, "cd apps/x && yarn test");
});

test("pnpm and yarn test commands go through the workspace", () => {
  const pnpm = run({
    "package.json": {},
    "pnpm-workspace.yaml": "packages: ['apps/*']\n",
    "apps/api/package.json": { name: "@acme/api", scripts: { test: "vitest" } },
  });
  assert.equal(pnpm[0].fields.test.value, "pnpm --filter @acme/api test");
  const yarn = run({
    "package.json": { workspaces: ["apps/*"] },
    "yarn.lock": "",
    "apps/api/package.json": { name: "api", scripts: { test: "jest" } },
  });
  assert.equal(yarn[0].fields.test.value, "yarn workspace api test");
});

test("a library with no dev/start script is not runnable; a bin makes a cli", () => {
  const found = run({
    "package.json": { workspaces: ["packages/*"] },
    "packages/utils/package.json": { name: "utils" },
    "packages/tool/package.json": { name: "tool", bin: { tool: "bin.js" } },
  });
  const utils = found.find((f) => f.name === "utils");
  const tool = found.find((f) => f.name === "tool");
  assert.equal(utils.runnable, false);
  assert.equal(tool.fields.type.value, "cli");
  assert.equal(tool.fields.archetype.value, "node-tool");
});

test("a typecheck script runs before test in the detected test command (SW-107)", () => {
  const scripts = { typecheck: "tsc --noEmit", test: "vitest" };
  const npm = run({
    "package.json": { workspaces: ["apps/*"] },
    "apps/api/package.json": { name: "api", scripts },
  });
  assert.equal(npm[0].fields.test.value, "npm run typecheck -w api && npm test -w api");
  assert.match(npm[0].fields.test.source, /scripts\.typecheck/);

  const pnpm = run({
    "package.json": {},
    "pnpm-workspace.yaml": "packages: ['apps/*']\n",
    "apps/api/package.json": { name: "@acme/api", scripts },
    "apps/x/package.json": { scripts },
  });
  assert.equal(
    pnpm[0].fields.test.value,
    "pnpm --filter @acme/api run typecheck && pnpm --filter @acme/api test",
  );
  assert.equal(
    pnpm[1].fields.test.value,
    "pnpm --filter ./apps/x run typecheck && pnpm --filter ./apps/x test",
  );

  const yarn = run({
    "package.json": { workspaces: ["apps/*"] },
    "yarn.lock": "",
    "apps/api/package.json": { name: "api", scripts },
    "apps/x/package.json": { scripts },
  });
  assert.equal(
    yarn[0].fields.test.value,
    "yarn workspace api run typecheck && yarn workspace api test",
  );
  assert.equal(yarn[1].fields.test.value, "cd apps/x && yarn run typecheck && yarn test");

  const root = run({ "package.json": { name: "shop", scripts } });
  assert.equal(root[0].fields.test.value, "npm run typecheck && npm test");
});

test("a typecheck script without a test script adds no test command", () => {
  const [svc] = run({ "package.json": { name: "lib", scripts: { typecheck: "tsc --noEmit" } } });
  assert.equal(svc.fields.test, undefined);
});
