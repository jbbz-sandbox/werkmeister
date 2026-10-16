// The reporter is what lets the stdio MCP servers import this library at all,
// so the two properties that make that safe are pinned here: nothing prints
// without an installed reporter, and concurrent scopes never see each other's
// events. The fourth test pins the CLI's own lines byte for byte — the
// migration is only safe if `sandbox` output cannot drift.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectingReporter,
  error,
  info,
  passthrough,
  raw,
  success,
  ttyReporter,
  warn,
  withReporter,
} from "./dist/reporter.js";

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

  assert.deepEqual(
    a.events.map((e) => e.msg),
    ["a-1", "a-2"],
  );
  assert.deepEqual(
    b.events.map((e) => e.msg),
    ["b-1", "b-2"],
  );
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
// infra.ts's headers are `console.log(`\n...\n`)` — the leading and trailing
// newlines are part of the string AND console.log adds its own, so the
// replacement needs two trailing. That off-by-one is the whole risk.
test("raw() reproduces a header that already ends in a newline", async () => {
  const header = `\n\x1b[1m=== sandbox down: infra ===\x1b[0m\n`;
  const realWrite = process.stdout.write.bind(process.stdout);

  const viaConsole = [];
  process.stdout.write = (c) => (viaConsole.push(c), true);
  try {
    console.log(header);
  } finally {
    process.stdout.write = realWrite;
  }

  const viaRaw = [];
  process.stdout.write = (c) => (viaRaw.push(c), true);
  try {
    await withReporter(ttyReporter, async () => raw(`${header}\n`));
  } finally {
    process.stdout.write = realWrite;
  }

  assert.equal(viaRaw.join(""), viaConsole.join(""));
});

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

// `runWorkspaceAction` stopped shelling out to the CLI and now collects this
// transcript instead, so "what the dashboard shows" is only still "what the CLI
// printed" for as long as these two renderings agree. Compared against
// ttyReporter's real stdout writes rather than a hand-written expectation,
// because a hand-written one would drift with the same edit that breaks this.
test("collectingReporter is byte-identical to what ttyReporter prints", async () => {
  const emitAll = async () => {
    info("hello");
    success("hello");
    warn("hello");
    error("hello");
    raw("  a bare line\n");
    raw("\n");
  };

  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  const printed = [];
  process.stdout.write = (c) => (printed.push(c), true);
  console.log = (line) => printed.push(`${line}\n`);
  try {
    await withReporter(ttyReporter, emitAll);
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
  }

  const collector = collectingReporter();
  await withReporter(collector, emitAll);

  assert.equal(collector.text(), printed.join(""));
});

// The dashboard's stdout is its MCP JSON-RPC channel: a child process that
// inherited it would corrupt the protocol, which is the whole reason this
// reporter exists rather than the tty one.
test("collectingReporter never lets a child inherit stdio", () => {
  assert.equal(collectingReporter().passthrough, false);
});

// `createWorkspace` streams progress to a caller's `onData` while still
// returning the whole transcript, so the live half and the collected half must
// be the same bytes in the same order — a difference between them is a
// difference between what the dashboard shows during a run and after it.
test("collectingReporter's live callback matches the text it collects", async () => {
  const live = [];
  const collector = collectingReporter((chunk) => live.push(chunk));
  await withReporter(collector, async () => {
    info("one");
    raw("bare\n");
    warn("two");
    raw("to stderr\n", "stderr");
  });
  assert.equal(live.join(""), collector.text());
  assert.equal(live.length, 4);
});

// The docker build in `initWorkspace` asks this before choosing between
// inherited stdio and capture-and-replay. Answering `true` where no reporter
// owns a TTY is how a chatty child ends up in an MCP transport.
test("passthrough() is false unless a TTY-owning reporter is installed", async () => {
  assert.equal(passthrough(), false);
  await withReporter(collectingReporter(), async () => assert.equal(passthrough(), false));
  await withReporter(ttyReporter, async () => assert.equal(passthrough(), true));
});
