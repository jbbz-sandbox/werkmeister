// The first two stages every detection run depends on: which files exist,
// and which directories are workspace packages.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectWorkspace,
  expandWorkspaceGlobs,
  listRepoFiles,
} from "./dist/fragment_detect/index.js";
import { ctxFor, fixture, noTools } from "./fragment-detect-helpers.mjs";

test("listRepoFiles walks a non-git dir, pruning node_modules and dot dirs but keeping dotfiles", () => {
  const root = fixture({
    "package.json": {},
    ".nvmrc": "22\n",
    "node_modules/x/Dockerfile": "FROM x",
    ".github/workflows/ci.yml": "on: push",
    "apps/a/package.json": {},
  });
  assert.deepEqual(listRepoFiles(root, noTools), [".nvmrc", "apps/a/package.json", "package.json"]);
});

test("listRepoFiles drops node_modules even when git lists it", () => {
  const root = fixture({ "package.json": {}, "node_modules/x/Dockerfile": "FROM x" });
  const git = (cmd) =>
    cmd[0] === "git" ? [0, "node_modules/x/Dockerfile\npackage.json\n"] : [127, ""];
  assert.deepEqual(listRepoFiles(root, git), ["package.json"]);
});

test("npm workspaces give the package dirs and a shared install named after the repo", () => {
  const root = fixture(
    {
      "package.json": { workspaces: ["apps/*"] },
      "package-lock.json": "{}",
      "apps/backend/package.json": { name: "backend" },
      "apps/frontend/package.json": { name: "frontend" },
      "tools/x/package.json": { name: "x" },
    },
    "demo-services",
  );
  const ws = detectWorkspace(ctxFor(root));
  assert.equal(ws.pm, "npm");
  assert.deepEqual(ws.packageDirs, ["apps/backend", "apps/frontend"]);
  assert.equal(ws.setupName, "demo-services-install");
  assert.equal(
    ws.setupFields.command.value,
    "npm ci",
    "a lockfile means an install that can't rewrite it",
  );
  assert.equal(ws.setupFields.node_modules_volume.value, "demo-services-node-modules");
});

test("pnpm-workspace.yaml selects pnpm and its package globs", () => {
  const root = fixture({
    "package.json": { name: "root" },
    "pnpm-workspace.yaml": "packages:\n  - 'services/**'\n",
    "services/api/package.json": { name: "api" },
    "services/group/worker/package.json": { name: "worker" },
  });
  const ws = detectWorkspace(ctxFor(root));
  assert.equal(ws.pm, "pnpm");
  assert.deepEqual(ws.packageDirs, ["services/api", "services/group/worker"]);
  assert.equal(ws.setupFields.command.value, "corepack enable && pnpm install");
});

test("a pnpm lockfile gives a frozen install", () => {
  const root = fixture({
    "package.json": { name: "root" },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  assert.equal(
    detectWorkspace(ctxFor(root)).setupFields.command.value,
    "corepack enable && pnpm install --frozen-lockfile",
  );
});

test("negated workspace patterns exclude", () => {
  const files = ["packages/a/package.json", "packages/legacy/package.json"];
  assert.deepEqual(expandWorkspaceGlobs(["packages/*", "!packages/legacy"], files), ["packages/a"]);
});

test("no root package.json means no workspace and no setup service", () => {
  const ws = detectWorkspace(ctxFor(fixture({ Dockerfile: "FROM golang:1.23" })));
  assert.deepEqual(ws.packageDirs, []);
  assert.equal(ws.setupName, null);
});

test("a single-package repo still gets a setup service", () => {
  const ws = detectWorkspace(ctxFor(fixture({ "package.json": { name: "shop" } }, "shop")));
  assert.deepEqual(ws.packageDirs, []);
  assert.equal(ws.setupName, "shop-install");
});

test("an existing fragment's setup service name is reused", () => {
  const root = fixture({ "package.json": { workspaces: ["apps/*"] } }, "demo-services");
  assert.equal(detectWorkspace(ctxFor(root), "demo-install").setupName, "demo-install");
});

test("an existing fragment's node_modules volume name is reused", () => {
  const root = fixture({ "package.json": { workspaces: ["apps/*"] } }, "demo-services");
  const ws = detectWorkspace(ctxFor(root), "demo-install", "node-modules");
  assert.equal(ws.setupFields.node_modules_volume.value, "node-modules");
});
