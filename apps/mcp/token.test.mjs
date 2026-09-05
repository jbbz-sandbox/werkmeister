// The predicate is the whole authentication rule, in one place: a token is
// required whenever the bind is not loopback, and a present token is always
// checked. Hermetic -- os.homedir() honours $HOME, so ~/.sandbox moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { authorized, isLoopback, readOrCreateToken, tokenPath } from "./dist/lib/token.js";

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

test("a loopback bind accepts a missing header, so host clients need no config", () => {
  assert.equal(authorized(undefined, "abc", "127.0.0.1"), true);
  assert.equal(isLoopback("::1"), true);
});

test("a non-loopback bind refuses a missing header", () => {
  assert.equal(authorized(undefined, "abc", "0.0.0.0"), false);
});

test("a present token is checked on every bind, right or wrong", () => {
  assert.equal(authorized("Bearer abc", "abc", "127.0.0.1"), true);
  assert.equal(authorized("Bearer abc", "abc", "0.0.0.0"), true);
  assert.equal(authorized("Bearer wrong", "abc", "127.0.0.1"), false);
  assert.equal(authorized("Bearer wrong", "abc", "0.0.0.0"), false);
});

test("a malformed or wrong-length credential is refused, not compared", () => {
  assert.equal(authorized("abc", "abc", "0.0.0.0"), false);
  assert.equal(authorized("Bearer ", "abc", "0.0.0.0"), false);
  // timingSafeEqual throws on unequal lengths; the length check must come first.
  assert.equal(authorized("Bearer abcdefgh", "abc", "0.0.0.0"), false);
});
