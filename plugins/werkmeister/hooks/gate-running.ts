import type { EngineInterface } from "claude-code";

/** Three of `runGate`'s 60 s beats: an older marker was left by a gate that was killed. */
const STALE_MS = 3 * 60_000;

/**
 * SW-1213: whether a `werkmeister pr gate` is running in the workspace at *root*: its `runGate`
 * keeps `.werkmeister/gate-running` fresh and removes it when done. A stage's proposed review.md
 * waits on that gate, so the Stop guard asks once it has ended, not on every wait for it.
 */
export async function gateRunning($: EngineInterface, root: string): Promise<boolean> {
  const files = await $.fs.list(`${root}/.werkmeister`).catch(() => []);
  const marker = files.find((f) => f.name === "gate-running" && f.kind === "file");
  return !!marker && (await $.clock.now()) - marker.mtimeMs < STALE_MS;
}
