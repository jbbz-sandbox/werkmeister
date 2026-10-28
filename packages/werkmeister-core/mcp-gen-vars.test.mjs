// The feature has to travel per workspace, and the definition registry is one
// shared free-form blob -- so substitution happens on the way out, over the
// definition body, rather than as a field the registry schema knows about.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { resolveWorkspaceMcpServers, writeWorkspaceMcp } from "./dist/mcp_gen.js";
import { REGISTRY_DEFAULTS } from "./dist/scaffold.js";

const DEFINITIONS = {
  sandbox: {
    type: "http",
    url: "http://host.docker.internal:3002/mcp",
    headers: {
      Authorization: "Bearer ${WERKMEISTER_MCP_TOKEN}",
      "X-Werkmeister-Feature": "${FEATURE}",
    },
  },
};

function withWorkspace(fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gen-vars-"));
  try {
    return fn(ws);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function readServers(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, ".mcp.json"), "utf8")).mcpServers;
}

test("a named var is substituted into string values at any depth", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    assert.equal(readServers(ws).sandbox.headers["X-Werkmeister-Feature"], "frontend");
  });
});

test("an unnamed var is written through untouched for the MCP client to expand", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    // The token must never be baked into a file inside a git worktree.
    assert.equal(readServers(ws).sandbox.headers.Authorization, "Bearer ${WERKMEISTER_MCP_TOKEN}");
  });
});

test("two workspaces get two different features from one definition registry", () => {
  withWorkspace((a) =>
    withWorkspace((b) => {
      writeWorkspaceMcp(a, ["sandbox"], DEFINITIONS, { FEATURE: "alpha" });
      writeWorkspaceMcp(b, ["sandbox"], DEFINITIONS, { FEATURE: "beta" });
      assert.equal(readServers(a).sandbox.headers["X-Werkmeister-Feature"], "alpha");
      assert.equal(readServers(b).sandbox.headers["X-Werkmeister-Feature"], "beta");
    }),
  );
});

test("substitution never mutates the caller's definition registry", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS, { FEATURE: "frontend" });
    assert.equal(DEFINITIONS.sandbox.headers["X-Werkmeister-Feature"], "${FEATURE}");
  });
});

test("no vars leaves every definition exactly as given", () => {
  withWorkspace((ws) => {
    writeWorkspaceMcp(ws, ["sandbox"], DEFINITIONS);
    assert.equal(readServers(ws).sandbox.headers["X-Werkmeister-Feature"], "${FEATURE}");
  });
});

// SW-115: a shipped archetype projecting it breaks every host session.
test("no default archetype projects the container-only werkmeister server", () => {
  withWorkspace((ws) => {
    const { archetypes, mcp_servers } = REGISTRY_DEFAULTS;
    const present = Object.fromEntries(Object.keys(archetypes).map((a) => [a, ["svc"]]));
    writeWorkspaceMcp(ws, resolveWorkspaceMcpServers(present, archetypes), mcp_servers);
    assert.equal(readServers(ws).werkmeister, undefined);
  });
});
