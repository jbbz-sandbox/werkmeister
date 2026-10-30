import { defineConfig } from "vitest/config";

// Cases spawn processes and do heavy fs work, and their wall time scales with host load: next to other
// workspaces' suites a 1 s case takes 10-50 s, so vitest's 5 s/10 s defaults fail whichever case starves (#178, #206).
// No daemon at DOCKER_HOST, so a Docker call a test forgot to mock fails in ms instead of waiting on the
// host's loaded daemon: a sync `docker ps` blocking a fork past vitest's fixed 60 s worker RPC timeout
// fails a green run, and an unbounded dockerode `df` hangs a case to testTimeout (SW-158).
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Likewise no werkmeister daemon: the scheduler falls back in-process rather than reach the host's (SW-185).
    env: {
      DOCKER_HOST: "unix:///nonexistent/werkmeister-tests.sock",
      WERKMEISTER_HOST: "http://127.0.0.1:9",
    },
  },
});
