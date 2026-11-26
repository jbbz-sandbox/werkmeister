// SW-1198: githubOutage reads githubstatus.com's components and stays silent when it can't.

import assert from "node:assert/strict";
import { test } from "node:test";

import { githubOutage } from "../dist/pr_lifecycle.js";

const comps = (pr, git) => ({
  components: [
    { name: "Webhooks", status: "major_outage" },
    { name: "Git Operations", status: git },
    { name: "Pull Requests", status: pr },
  ],
});
const reply =
  (body, status = 200) =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

test("a non-operational Pull Requests names the component and status", async () => {
  const out = await githubOutage(reply(comps("partial_outage", "operational")));
  assert.equal(
    out,
    "GitHub Pull Requests: partial_outage; nothing was created; retry when https://www.githubstatus.com shows it operational",
  );
});

test("Git Operations alone, and both, are named; Webhooks is ignored", async () => {
  assert.match(
    (await githubOutage(reply(comps("operational", "major_outage")))) ?? "",
    /^GitHub Git Operations: major_outage;/,
  );
  assert.match(
    (await githubOutage(reply(comps("partial_outage", "degraded_performance")))) ?? "",
    /^GitHub Git Operations: degraded_performance, Pull Requests: partial_outage;/,
  );
});

test("both operational prints nothing", async () => {
  assert.equal(await githubOutage(reply(comps("operational", "operational"))), null);
});

test("network error, timeout, non-200 and bad JSON print nothing", async () => {
  assert.equal(
    await githubOutage(async () => {
      throw new Error("ENOTFOUND");
    }),
    null,
  );
  // The request carries a timeout signal; a fetch it aborts rejects (not waited out: the 5 s is the signal's).
  let signal;
  assert.equal(
    await githubOutage(async (_u, o) => {
      signal = o.signal;
      throw new DOMException("timed out", "TimeoutError");
    }),
    null,
  );
  assert.ok(signal instanceof AbortSignal);
  assert.equal(await githubOutage(reply(comps("partial_outage", "operational"), 503)), null);
  assert.equal(await githubOutage(reply("<html>")), null);
  assert.equal(await githubOutage(reply({ nope: 1 })), null);
});
