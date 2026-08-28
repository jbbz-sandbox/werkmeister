// The reporter is what lets `sandbox mcp --stdio` import this library at all,
// so the two properties that make that safe are pinned here: nothing prints
// without an installed reporter, and concurrent scopes never see each other's
// events. The fourth test pins the CLI's own lines byte for byte — the
// migration is only safe if `sandbox` output cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";

import { info, success, warn, error, raw, withReporter, ttyReporter } from "./dist/reporter.js";

const recorder = () => {
  const events = [];
  return { events, reporter: { emit: (e) => events.push(e), passthrough: false } };
};

test("collects the events emitted inside its scope", async () => {
  const { events, reporter } = recorder();
  await withReporter(reporter, async () => {
    info("one");
    success("two");
    warn("three");
    error("four");
  });
  assert.deepEqual(events, [
    { level: "info", msg: "one" },
    { level: "ok", msg: "two" },
    { level: "warn", msg: "three" },
    { level: "error", msg: "four" },
  ]);
});

test("silent, not fatal, with no reporter installed", () => {
  const logged = [];
  const real = console.log;
  console.log = (...a) => logged.push(a);
  try {
    info("nobody is listening");
  } finally {
    console.log = real;
  }
  assert.deepEqual(logged, []);
});

test("concurrent scopes do not interleave", async () => {
  const a = recorder();
  const b = recorder();
  const yielded = (label, rec) =>
    withReporter(rec.reporter, async () => {
      info(`${label}-1`);
      await new Promise((r) => setTimeout(r, 5));
      info(`${label}-2`);
    });

  await Promise.all([yielded("a", a), yielded("b", b)]);

  assert.deepEqual(a.events.map((e) => e.msg), ["a-1", "a-2"]);
  assert.deepEqual(b.events.map((e) => e.msg), ["b-1", "b-2"]);
});

test("ttyReporter reproduces the CLI's lines byte for byte", async () => {
  const logged = [];
  const real = console.log;
  console.log = (line) => logged.push(line);
  try {
    await withReporter(ttyReporter, async () => {
      info("hello");
      success("hello");
      warn("hello");
      error("hello");
    });
  } finally {
    console.log = real;
  }
  assert.deepEqual(logged, [
    "\x1b[36m[info] hello\x1b[0m",
    "\x1b[32m[ok]   hello\x1b[0m",
    "\x1b[33m[warn] hello\x1b[0m",
    "\x1b[31m[err]  hello\x1b[0m",
  ]);
});

// The console-write conversion in infra/detect/caddy replaced `console.log(s)`
// with `raw(s + "\n")`. This asserts those are the same bytes on the wire, which
// is the whole safety claim behind that change.
test("raw() through ttyReporter is byte-identical to console.log", async () => {
  const line = `\x1b[1m=== sandbox down: infra ===\x1b[0m`;
  const realWrite = process.stdout.write.bind(process.stdout);

  const viaConsole = [];
  process.stdout.write = (c) => (viaConsole.push(c), true);
  try {
    console.log(line);
  } finally {
    process.stdout.write = realWrite;
  }

  const viaRaw = [];
  process.stdout.write = (c) => (viaRaw.push(c), true);
  try {
    await withReporter(ttyReporter, async () => raw(`${line}\n`));
  } finally {
    process.stdout.write = realWrite;
  }

  assert.equal(viaRaw.join(""), viaConsole.join(""));
});

test("raw() carries no level prefix and can target stderr", async () => {
  const events = [];
  await withReporter({ emit: (e) => events.push(e), passthrough: false }, async () => {
    raw("plain\n");
    raw("oops\n", "stderr");
  });
  assert.deepEqual(events, [
    { level: "raw", chunk: "plain\n", stream: "stdout" },
    { level: "raw", chunk: "oops\n", stream: "stderr" },
  ]);
});
