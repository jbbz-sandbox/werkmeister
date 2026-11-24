// SW-1136: `vite build --watch` fails every rebuild after the first ("[commonjs] Cannot read properties of
// undefined (reading 'resolved')"), so `watch:ui` reruns this full build under `node --watch-path` instead.
// shortcut: each edit rebuilds both pages (~40 s); go back to vite's watcher once its incremental rebuild works (SW-1163).
import { spawn } from "node:child_process";

// Its own process group: a restart signals only this script, so the running build must end with it,
// or two builds race on dist/ and the older one can land last.
const build = spawn("pnpm", ["run", "build:ui"], { stdio: "inherit", detached: true });
const stop = () => {
  try {
    process.kill(-build.pid, "SIGTERM");
  } catch {
    /* already exited */
  }
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
build.on("exit", (code) => process.exit(code ?? 1));
