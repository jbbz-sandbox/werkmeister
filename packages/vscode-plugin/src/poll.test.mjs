import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { pollWhileVisible } from "../out/poll.js";

/** A stand-in for vscode.TreeView: flip visibility and the listeners fire. */
function fakeView(visible) {
  const listeners = new Set();
  return {
    visible,
    disposed: false,
    onDidChangeVisibility(listener) {
      listeners.add(listener);
      return {
        dispose: () => {
          this.disposed = true;
          listeners.delete(listener);
        },
      };
    },
    /** What VS Code does when the user switches activity-bar containers. */
    setVisible(next) {
      this.visible = next;
      for (const l of listeners) l({ visible: next });
    },
  };
}

/** Counts ticks while driving fake time; returns the teardown. */
function poll(view, intervalMs = 5000) {
  const ticks = { count: 0 };
  const stop = pollWhileVisible(view, () => (ticks.count += 1), intervalMs);
  return { ticks, stop };
}

test("a view that starts visible ticks immediately, then on the interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { ticks } = poll(fakeView(true));

  assert.equal(ticks.count, 1, "the first fetch must not wait a whole interval");
  t.mock.timers.tick(5000);
  t.mock.timers.tick(5000);
  assert.equal(ticks.count, 3);
});

// The whole point of the gating: a hidden view costs nothing.
test("a view that starts hidden never ticks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { ticks } = poll(fakeView(false));

  t.mock.timers.tick(60_000);
  assert.equal(ticks.count, 0);
});

test("going hidden stops the polling", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = fakeView(true);
  const { ticks } = poll(view);

  t.mock.timers.tick(5000);
  assert.equal(ticks.count, 2);

  view.setVisible(false);
  t.mock.timers.tick(60_000);
  assert.equal(ticks.count, 2, "no tick may land while hidden");
});

test("coming back into view resumes, and refetches at once rather than waiting", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = fakeView(true);
  const { ticks } = poll(view);

  view.setVisible(false);
  t.mock.timers.tick(60_000);
  view.setVisible(true);
  assert.equal(ticks.count, 2, "stale data must not show while the interval elapses");

  t.mock.timers.tick(5000);
  assert.equal(ticks.count, 3);
});

// A duplicate visible=true would leave a second interval running with no handle
// to clear it, silently doubling the docker ps rate for the session.
test("a repeated visible event does not start a second interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = fakeView(true);
  const { ticks } = poll(view);

  view.setVisible(true);
  view.setVisible(true);
  assert.equal(ticks.count, 1, "an already-visible view must not refetch");

  t.mock.timers.tick(5000);
  assert.equal(ticks.count, 2, "one interval, not three");
});

test("teardown unsubscribes and stops the interval", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const view = fakeView(true);
  const { ticks, stop } = poll(view);

  stop();
  assert.equal(view.disposed, true, "the visibility subscription must be released");

  t.mock.timers.tick(60_000);
  assert.equal(ticks.count, 1, "no tick may land after teardown");
});

test("teardown is safe on a view that was never visible", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { stop } = poll(fakeView(false));
  assert.doesNotThrow(stop);
});
