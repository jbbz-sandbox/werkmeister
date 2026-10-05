/**
 * Run `tick` on an interval, but only while the source reports itself visible.
 *
 * Lifted out of SandboxTreeProvider so it can be tested without an extension
 * host. The behaviour matters — a hidden view must not keep sweeping `docker ps`
 * — and the only way to confirm it in a live editor was a temporary
 * `console.log` (MANUAL-CHECKLIST step 6), which is why it went unchecked.
 */

/** The slice of `vscode.TreeView` this needs, structural so nothing imports vscode. */
export interface VisibilitySource {
  readonly visible: boolean;
  onDidChangeVisibility(listener: (e: { visible: boolean }) => void): { dispose(): void };
}

/** Returns the teardown: unsubscribes and clears any running interval. */
export function pollWhileVisible(
  source: VisibilitySource,
  tick: () => void,
  intervalMs: number,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const sync = (visible: boolean) => {
    // The `!timer` guard is load-bearing: onDidChangeVisibility can fire
    // visible=true when already visible, and a second interval would double the
    // poll rate with no way to clear the orphan.
    if (visible && !timer) {
      tick();
      timer = setInterval(tick, intervalMs);
    } else if (!visible && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  sync(source.visible);
  const sub = source.onDidChangeVisibility((e) => sync(e.visible));

  return () => {
    sub.dispose();
    if (timer) clearInterval(timer);
    timer = undefined;
  };
}
