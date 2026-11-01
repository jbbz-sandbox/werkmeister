/**
 * SW-306: the daemon keeps serving the code it loaded until it exits, so it
 * watches its own entry and leaves once that changes and nothing is in flight.
 * launchd's KeepAlive starts it again on the new build. Leaving mid-call would
 * cut a gate's scheduler op, and a queued feature still needs this process's grant.
 */

export interface RestartGuard {
  readonly loaded: string | null;
  /** Count *work* as in flight; once it settles, exit if the build changed meanwhile. */
  track<T>(work: () => Promise<T>): Promise<T>;
  /** Re-read the on-disk build and exit if it changed and nothing is in flight. */
  check(): void;
  status(): {
    loaded: string | null;
    onDisk: string | null;
    stale: boolean;
    inFlight: number;
    queued: number;
    restartPending: boolean;
  };
}

export function restartGuard(deps: {
  entry: string;
  build: (entry: string) => string | null;
  queued: () => number;
  /** Absent when nothing would restart this process: it then only reports `stale`. */
  exit?: () => void;
  log?: (msg: string) => void;
}): RestartGuard {
  const loaded = deps.build(deps.entry);
  let onDisk = loaded;
  let inFlight = 0;
  let exiting = false;
  const stale = () => onDisk !== null && onDisk !== loaded;

  const check = () => {
    onDisk = deps.build(deps.entry) ?? onDisk;
    if (exiting || !deps.exit || !stale() || inFlight > 0 || deps.queued() > 0) return;
    exiting = true;
    deps.log?.(`build changed (loaded ${loaded}, on disk ${onDisk}) and idle: exiting to restart`);
    deps.exit();
  };

  return {
    loaded,
    async track(work) {
      inFlight++;
      try {
        return await work();
      } finally {
        inFlight--;
        check();
      }
    },
    check,
    status: () => ({
      loaded,
      onDisk,
      stale: stale(),
      inFlight,
      queued: deps.queued(),
      restartPending: stale() && deps.exit !== undefined,
    }),
  };
}
