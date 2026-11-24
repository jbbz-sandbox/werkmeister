// SW-1142: the Metrics tab calls `metrics-trends` once per open and once per range change, and
// none while hidden. Renders the real MetricsTab in happy-dom; the bridge is a counting stub.
//   node test/metrics-refetch.smoke.mjs
import assert from "node:assert";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { register } from "tsx/esm/api";

const win = new Window();
for (const k of ["window", "document", "navigator", "HTMLElement", "Node"]) {
  Object.defineProperty(globalThis, k, {
    value: k === "window" ? win : win[k],
    configurable: true,
  });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

register();
// werkmeister-ui's theme.js imports tokens.css, which node can't load; serve it empty.
registerHooks({
  load: (url, ctx, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "export default ''", shortCircuit: true }
      : next(url, ctx),
});
const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { MetricsTab } = await import(path.join(pkgRoot, "src/metrics-ui.tsx"));
const { createElement } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");

const calls = [];
const bridge = {
  callTool: async (name, args) => {
    calls.push({ name, ...args });
    return { range: args.range, bucket: args.bucket, rows: [] };
  },
};

const root = createRoot(document.body.appendChild(document.createElement("div")));
const show = (active) =>
  act(async () => root.render(createElement(MetricsTab, { bridge, active })));
const count = () => calls.filter((c) => c.name === "metrics-trends").length;

await show(false);
assert.equal(count(), 0, "mounted hidden: no call");
await show(true);
assert.equal(count(), 1, "opened: one call");
await show(false);
assert.equal(count(), 1, "hidden: no call");
await show(true);
assert.equal(count(), 2, "opened again: one more call");

const btn = [...document.querySelectorAll(".ranges button")].find((b) => b.textContent === "7d");
assert.ok(btn, "7d range button");
await act(async () => btn.click());
assert.equal(count(), 3, "range change: one more call");
assert.equal(calls.at(-1).range, "7d", "the call carries the new range");

await show(false);
await act(async () => btn.click());
assert.equal(count(), 3, "range click while hidden: no call");

await act(async () => root.unmount());
await win.happyDOM.close();
console.log("metrics-refetch.smoke: ok");
