// The predicate is the whole authentication rule, in one place: a token is
// required on every bind, and a present token is always checked. Hermetic -- os.homedir() honours $HOME, so ~/.sandbox moves.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { authorized, readOrCreateToken, scopeOf, tokenPath } from "./dist/lib/token.js";

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-token-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("the token is created 0600 on first read and reused after", () => {
  withHome(() => {
    const first = readOrCreateToken();
    assert.match(first, /^[0-9a-f]{64}$/);
    assert.equal(fs.statSync(tokenPath()).mode & 0o777, 0o600);
    assert.equal(readOrCreateToken(), first);
  });
});

// SW-631: on OrbStack a container's request to host.docker.internal arrives from 127.0.0.1,
// so a loopback bind can't tell it from a host process. No header is nobody.
test("a missing header is refused", () => {
  assert.equal(authorized(undefined, "abc"), false);
});

test("a present token is checked, right or wrong", () => {
  assert.equal(authorized("Bearer abc", "abc"), true);
  assert.equal(authorized("Bearer wrong", "abc"), false);
});

test("a malformed or wrong-length credential is refused, not compared", () => {
  assert.equal(authorized("abc", "abc"), false);
  assert.equal(authorized("Bearer ", "abc"), false);
  // timingSafeEqual throws on unequal lengths; the length check must come first.
  assert.equal(authorized("Bearer abcdefgh", "abc"), false);
});

// SW-184: one machine token for the host, one token per workspace under ~/.werkmeister/tokens/.
test("scopeOf: the machine token is the host, a workspace token is that workspace", () => {
  withHome((home) => {
    const tokens = path.join(home, ".werkmeister", "tokens");
    fs.mkdirSync(tokens, { recursive: true });
    fs.writeFileSync(path.join(tokens, "proj-a"), `${"a".repeat(64)}\n`);
    fs.writeFileSync(path.join(tokens, "proj-b"), `${"b".repeat(64)}\n`);
    const bearer = (t) => `Bearer ${t}`;
    assert.deepEqual(scopeOf(bearer("m".repeat(64)), "m".repeat(64)), {
      scope: "machine",
    });
    assert.deepEqual(scopeOf(bearer("b".repeat(64)), "m".repeat(64)), {
      scope: "workspace",
      name: "proj-b",
    });
    assert.equal(scopeOf(bearer("z".repeat(64)), "m".repeat(64)), null);
  });
});

test("scopeOf: no header is nobody (SW-631)", () => {
  withHome(() => {
    assert.equal(scopeOf(undefined, "m"), null);
  });
});
