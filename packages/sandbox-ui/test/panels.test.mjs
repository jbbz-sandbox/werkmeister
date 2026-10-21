// The usage breakdown, the options input and the chat panel's view, rendered with
// react-dom/server (SW-57). The transports (SSE, polling) need a browser.
// Run: npm run build && node --test test/panels.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { Usage } = await import("../dist/usage-widget.js");
const { OptionsInput } = await import("../dist/options-input.js");
const { ChatView } = await import("../dist/chat-panel.js");

const totals = (n) => ({ input: n, output: 0, cacheCreation: 0, cacheRead: 0 });

test("usage: totals, per-model split, the costliest session flagged", () => {
  const html = renderToStaticMarkup(
    h(Usage, {
      usage: {
        name: "ws",
        totals: totals(1_500_000),
        estUsd: 3.456,
        byModel: [{ model: "opus", totals: totals(1_500_000), estUsd: 3.456 }],
        sessions: [
          { sessionId: "aaaaaaaa-1", title: "", updatedAt: "", totals: totals(2000), estUsd: 0.4 },
          {
            sessionId: "bbbbbbbb-2",
            title: "Big one",
            updatedAt: "",
            totals: totals(900),
            estUsd: 3,
          },
        ],
      },
    }),
  );
  assert.match(html, /<span class="usage-usd">~\$3\.46<\/span><span class="usage-tok">1\.5M tok/);
  assert.match(html, /in 1\.5M · out 0 · cache-r 0/);
  assert.match(html, /Sessions \(2\)/);
  assert.match(html, /usage-name">aaaaaaaa</, "untitled session shows its id prefix");
  assert.equal(html.match(/🔥/g)?.length, 1);
  assert.match(html, /Big one.*🔥/);
});

test("usage: nothing recorded yet", () => {
  const html = renderToStaticMarkup(
    h(Usage, { usage: { name: "ws", totals: totals(0), estUsd: null, byModel: [], sessions: [] } }),
  );
  assert.match(html, /class="usage-empty">No usage recorded for this workspace yet\./);
});

test("options input: a title and one idle button row per option", () => {
  const html = renderToStaticMarkup(
    h(OptionsInput, {
      title: "Your call:",
      options: [{ label: "Approve", description: "Approve this PR" }, { label: "Request changes" }],
      onSelect() {},
    }),
  );
  assert.match(html, /<div class="opt-title">Your call:<\/div>/);
  assert.equal(html.match(/<button type="button" class="opt-row">/g)?.length, 2);
  assert.match(html, /opt-label">Approve<\/span><span class="opt-desc">Approve this PR/);
  assert.doesNotMatch(html, /disabled=""/);
});

const st = (over = {}) => ({
  messages: [],
  loaded: true,
  sessionId: "aaaaaaaa-0000",
  sessionCount: 1,
  updatedAt: null,
  error: null,
  sending: false,
  ...over,
});
const noop = () => undefined;
const chat = (over = {}) =>
  renderToStaticMarkup(
    h(ChatView, {
      name: "ws",
      bridge: { callTool: async () => ({}) },
      inputDisabled: false,
      onPin: noop,
      onRefresh: noop,
      onSend: async () => {},
      onError: noop,
      ...over,
      st: st(over.st),
    }),
  );

test("chat: loading, then empty", () => {
  assert.match(chat({ st: { loaded: false } }), /class="msg-info">Loading session…/);
  const empty = chat({ st: { sessionId: null, sessionCount: 0 } });
  assert.match(empty, /No messages yet\./);
  assert.match(empty, /no sessions yet — sending starts one/);
});

test("chat: markdown only for assistant replies, and only when the host injects it", () => {
  const messages = [
    { role: "user", text: "**hi**" },
    { role: "assistant", text: "**done**" },
    { role: "tool", text: "Bash ls" },
  ];
  const md = chat({ st: { messages }, renderMarkdown: (s) => `<p>${s.replaceAll("*", "")}</p>` });
  assert.match(md, /<div class="msg msg-user">\*\*hi\*\*<\/div>/);
  assert.match(md, /<div class="msg msg-assistant md"><p>done<\/p><\/div>/);
  assert.match(md, /<div class="msg-tool" title="Bash ls">⚙ Bash ls<\/div>/);
  const plain = chat({ st: { messages: [{ role: "assistant", text: "<b>x</b>" }] } });
  assert.match(plain, /<div class="msg msg-assistant">&lt;b&gt;x&lt;\/b&gt;<\/div>/);
});

test("chat: session info, error line, typing dots, disabled input", () => {
  const html = chat({
    st: { sessionCount: 3, error: "Turn failed — boom.", sending: true },
    inputDisabled: true,
  });
  assert.match(html, /<span>aaaaaaaa… · 3 sessions<\/span>/);
  assert.match(html, /<div class="msg-err">Turn failed — boom\.<\/div>/);
  assert.match(html, /class="msg msg-assistant typing"><span><\/span><span><\/span><span><\/span>/);
  assert.match(html, /<textarea rows="1" placeholder="Message this Claude session…" disabled=""/);
  assert.doesNotMatch(html, /<select/, "the picker waits for the session list");
});
