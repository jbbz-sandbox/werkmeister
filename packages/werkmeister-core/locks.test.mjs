// SW-183: the lock wait must not block the event loop, or an in-process holder
// suspended at an await can never resume to release (the HTTP MCP server case).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { sandboxLock } from "./dist/locks.js";

/** Fresh HOME: locks live under ~/.werkmeister/locks. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "locks-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(path.join(home, ".werkmeister", "locks"));
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function plant(dir, name, content) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.lock`), content);
}

test("two in-process async holders run one after the other while the event loop keeps turning", async () => {
  await withHome(async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 10);
    const order = [];
    const hold = (id) => async () =>
      sandboxLock(
        "x",
        async () => {
          order.push(`${id}:in`);
          await sleep(200);
          order.push(`${id}:out`);
          return id;
        },
        { timeout: 2 },
      );
    try {
      assert.deepEqual(await Promise.all([hold("a")(), hold("b")()]), ["a", "b"]);
    } finally {
      clearInterval(ticker);
    }
    assert.deepEqual(order, ["a:in", "a:out", "b:in", "b:out"]);
    assert.ok(ticks >= 20, `event loop ticked only ${ticks} times in ~400ms`);
  });
});

test("a lock held by a dead PID is stolen", async () => {
  await withHome(async (dir) => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    plant(dir, "x", String(dead));
    assert.equal(await sandboxLock("x", () => "got", { timeout: 1 }), "got");
  });
});

test("a corrupt lock file is stolen", async () => {
  await withHome(async (dir) => {
    plant(dir, "x", "not-a-pid");
    assert.equal(await sandboxLock("x", () => "got", { timeout: 1 }), "got");
  });
});

test("the lock is released when fn throws or its promise rejects", async () => {
  await withHome(async (dir) => {
    await assert.rejects(
      async () =>
        sandboxLock("x", () => {
          throw new Error("sync boom");
        }),
      /sync boom/,
    );
    await assert.rejects(
      async () =>
        sandboxLock("x", async () => {
          throw new Error("async boom");
        }),
      /async boom/,
    );
    assert.equal(fs.existsSync(path.join(dir, "x.lock")), false);
  });
});

test("a live holder past the timeout rejects with the recovery hint", async () => {
  await withHome(async (dir) => {
    plant(dir, "x", String(process.pid));
    await assert.rejects(
      async () => sandboxLock("x", () => "never", { timeout: 0.3 }),
      /Timed out after 0.3s waiting for lock 'x'.*safe to delete/s,
    );
  });
});
