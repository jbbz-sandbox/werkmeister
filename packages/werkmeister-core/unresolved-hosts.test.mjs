// SW-341: `feature up` reported success while a routed host had no /etc/hosts
// entry, so curl failed with exit 6 after a green run. Driven through a fake
// lookup: the real resolver would make the result depend on the machine's
// /etc/hosts, which is the very thing the warning is about.

import assert from "node:assert/strict";
import { test } from "node:test";
import { warnUnresolvedHosts } from "./dist/feature_routing.js";
import { collectingReporter, withReporter } from "./dist/reporter.js";

/** `{ host: addresses }`; a missing host throws like ENOTFOUND does. */
function lookupFrom(table) {
  const calls = [];
  const lookup = async (host) => {
    calls.push(host);
    if (!(host in table))
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    return table[host].map((address) => ({ address }));
  };
  return { lookup, calls };
}

async function transcript(hosts, lookup) {
  const reporter = collectingReporter();
  const result = await withReporter(reporter, () => warnUnresolvedHosts(hosts, lookup));
  return { result, text: reporter.text() };
}

test("hosts that resolve to 127.0.0.1 produce no warning", async () => {
  const { lookup } = lookupFrom({ "a.test": ["127.0.0.1"], "b.test": ["::1", "127.0.0.1"] });
  const { result, text } = await transcript(["a.test", "b.test"], lookup);
  assert.deepEqual(result, []);
  assert.equal(text, "");
});

test("unresolved and misresolved hosts share one warning with the exact /etc/hosts line", async () => {
  const { lookup } = lookupFrom({ "b.test": ["10.0.0.5"], "c.test": ["127.0.0.1"] });
  const { result, text } = await transcript(["a.test", "b.test", "c.test"], lookup);
  assert.deepEqual(result, ["a.test", "b.test"]);
  assert.match(text, /2 routed hostname\(s\) do not resolve to 127\.0\.0\.1/);
  assert.match(text, /a\.test: no address/);
  assert.match(text, /b\.test: resolves to 10\.0\.0\.5/);
  assert.ok(text.includes('echo "127.0.0.1 a.test b.test" | sudo tee -a /etc/hosts'), text);
  assert.match(text, /werkmeister machine setup/);
  assert.match(text, /New hostnames need \/etc\/hosts entries/);
  assert.doesNotMatch(text, /c\.test/);
});

test("a host that resolves to ::1 only is warned about, and the line still says 127.0.0.1", async () => {
  const { lookup } = lookupFrom({ "v6.test": ["::1"] });
  const { result, text } = await transcript(["v6.test"], lookup);
  assert.deepEqual(result, ["v6.test"]);
  assert.match(text, /v6\.test: resolves to ::1/);
  assert.ok(text.includes('echo "127.0.0.1 v6.test" | sudo tee -a /etc/hosts'), text);
});

test("no routed hosts: nothing looked up, nothing printed", async () => {
  const { lookup, calls } = lookupFrom({});
  const { result, text } = await transcript([], lookup);
  assert.deepEqual(result, []);
  assert.deepEqual(calls, []);
  assert.equal(text, "");
});
