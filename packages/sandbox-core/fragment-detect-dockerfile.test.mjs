// Dockerfile → dev image (first FROM), port (EXPOSE), and a guessed command (CMD).

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectDockerfiles } from "./dist/fragment_detect/index.js";
import { ctxFor, fixture } from "./fragment-detect-helpers.mjs";

const detect = (files, name) => detectDockerfiles(ctxFor(fixture(files, name)));

test("the demo backend Dockerfile", () => {
  const [f] = detect({
    "apps/backend/Dockerfile":
      '# comment\nFROM node:22-alpine\nWORKDIR /app\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
  });
  assert.equal(f.name, "backend");
  assert.equal(f.dir, "apps/backend");
  assert.equal(f.fields.image.value, "node:22-alpine");
  assert.equal(f.fields.internal_port.value, 3000);
  assert.equal(f.fields.command.value, "cd apps/backend && exec node server.js");
  assert.equal(f.fields.command.confidence, "guessed");
});

test("multi-stage: the first FROM, skipping --platform and AS", () => {
  const [f] = detect(
    {
      Dockerfile:
        'FROM --platform=$BUILDPLATFORM golang:1.23 AS build\nRUN go build\nFROM gcr.io/distroless/base\nCMD ["/api"]\n',
    },
    "api",
  );
  assert.equal(f.dir, ".");
  assert.equal(f.name, "api");
  assert.equal(f.fields.image.value, "golang:1.23");
  assert.equal(f.fields.command.value, "/api");
});

test("FROM ${ARG} gives no image rather than a bogus one", () => {
  const [f] = detect({ Dockerfile: "ARG BASE=node:22\nFROM ${BASE}\nEXPOSE 8080/tcp\n" });
  assert.equal(f.fields.image, undefined);
  assert.equal(f.fields.internal_port.value, 8080);
});

test("CRLF line endings and backslash continuations", () => {
  const [f] = detect({
    Dockerfile: "FROM python:3.12\r\nEXPOSE \\\r\n  5000\r\nCMD python \\\r\n  app.py\r\n",
  });
  assert.equal(f.fields.image.value, "python:3.12");
  assert.equal(f.fields.internal_port.value, 5000);
  assert.equal(f.fields.command.value.replace(/\s+/g, " "), "python app.py");
});

test("a dev Dockerfile is listed before the production one in the same dir", () => {
  const found = detect({
    "svc/Dockerfile": "FROM node:22-alpine\n",
    "svc/Dockerfile.dev": "FROM node:22\n",
  });
  assert.deepEqual(
    found.map((f) => f.file),
    ["svc/Dockerfile.dev", "svc/Dockerfile"],
  );
});

test("ENTRYPOINT stands in when there is no CMD", () => {
  const [f] = detect({ Dockerfile: 'FROM alpine\nENTRYPOINT ["/bin/run", "--serve"]\n' });
  assert.equal(f.fields.command.value, "/bin/run --serve");
});

test("Dockerfile.md and Dockerfile.dockerignore are not Dockerfiles", () => {
  const found = detect({
    "docs/Dockerfile.md": "FROM node:22\n",
    "api/Dockerfile.dockerignore": "node_modules\n",
    "api/Dockerfile": "FROM golang:1.23\n",
  });
  assert.deepEqual(
    found.map((f) => f.file),
    ["api/Dockerfile"],
  );
});
