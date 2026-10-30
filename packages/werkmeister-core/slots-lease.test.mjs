// SW-166/169: a slot is leased the moment it is allocated, so back-to-back
// creates get distinct slots, and up/the gate never move a leased slot.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { leasesPath, readLeases } from "./dist/scheduler_state.js";
import { allocateSlot, releaseSlot, requireLeasedSlot } from "./dist/slots.js";
import { withSandboxHome } from "./fixtures.mjs";

/** Fresh HOME (locks and leases live under it) and seeded registry; no Docker. */
async function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "slots-lease-home-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await withSandboxHome(() => fn(home));
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const labels = (byFeature) => ({ labels: async () => byFeature });
const noContainers = labels({});
const ws = (home, name) => {
  const dir = path.join(home, "features", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

test("back-to-back allocations with no containers yet get distinct slots, both leased", async () => {
  await withHome(async (home) => {
    const a = await allocateSlot("a", null, ws(home, "a"), noContainers);
    const b = await allocateSlot("b", null, ws(home, "b"), noContainers);
    assert.notEqual(a, b);
    assert.deepEqual(
      Object.fromEntries(Object.entries(readLeases()).map(([f, l]) => [f, l.slot])),
      { a, b },
    );
    // Idempotent: asking again returns the leased slot.
    assert.equal(await allocateSlot("a", null, ws(home, "a"), noContainers), a);
  });
});

test("concurrent allocations from two processes get distinct slots under the lock", async () => {
  await withHome(async (home) => {
    const script = (feature) => `
      import { allocateSlot } from "./dist/slots.js";
      const slot = await allocateSlot(${JSON.stringify(feature)}, null, ${JSON.stringify(ws(home, feature))},
        { labels: async () => { await new Promise((r) => setTimeout(r, 200)); return {}; } });
      console.log(slot);`;
    const env = { ...process.env, HOME: home };
    const start = (f) =>
      new Promise((resolve, reject) => {
        const c = spawn(process.execPath, ["--input-type=module", "-e", script(f)], {
          env,
          cwd: import.meta.dirname,
        });
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
      });
    const outs = await Promise.all([start("a"), start("b")]);
    const slots = outs.map((o) => Number(o.trim().split("\n").at(-1)));
    assert.equal(new Set(slots).size, 2, `both got ${slots}`);
    assert.equal(Object.keys(readLeases()).length, 2);
  });
});

test("up/gate keep the leased slot while a sibling runs on another one", async () => {
  await withHome(async (home) => {
    const dir = ws(home, "mine");
    await allocateSlot("mine", 2, dir, noContainers);
    const slot = await requireLeasedSlot(
      "mine",
      dir,
      2,
      labels({ sib: { slot: 1, services: [] } }),
    );
    assert.equal(slot, 2);
  });
});

test("a sibling's containers on the leased slot fail SLOT_ALLOC naming it, never another slot", async () => {
  await withHome(async (home) => {
    const dir = ws(home, "mine");
    await allocateSlot("mine", 1, dir, noContainers);
    await assert.rejects(
      requireLeasedSlot("mine", dir, 1, labels({ sib: { slot: 1, services: [] } })),
      (e) => e.code === "SLOT_ALLOC" && /'sib'/.test(e.message),
    );
    assert.equal(readLeases().mine.slot, 1);
  });
});

test("no lease yet: requireLeasedSlot allocates one, skipping slots siblings hold", async () => {
  await withHome(async (home) => {
    const slot = await requireLeasedSlot(
      "new",
      ws(home, "new"),
      1,
      labels({ sib: { slot: 1, services: [] } }),
    );
    assert.equal(slot, 2);
    assert.equal(readLeases().new.slot, 2);
  });
});

test("releaseSlot ends the lease; a lease whose workspace is gone is pruned; labels backfill", async () => {
  await withHome(async (home) => {
    await allocateSlot("a", null, ws(home, "a"), noContainers);
    await releaseSlot("a");
    assert.equal(readLeases().a, undefined);

    const gone = ws(home, "gone");
    await allocateSlot("gone", 1, gone, noContainers);
    fs.rmSync(gone, { recursive: true });
    // Labelled "old" predates leases: it keeps slot 3 and gets a lease for it.
    const s = await allocateSlot("b", 1, ws(home, "b"), labels({ old: { slot: 3, services: [] } }));
    assert.equal(s, 1, "slot 1 freed by the prune");
    const leases = readLeases();
    assert.equal(leases.gone, undefined);
    assert.equal(leases.old.slot, 3);
    assert.ok(fs.existsSync(leasesPath()));
  });
});
