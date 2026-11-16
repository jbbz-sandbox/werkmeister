import { type ExecFileOptions, execFile } from "node:child_process";

/** Async execFile that never rejects, so a vitest worker isn't blocked by a child (SW-744, SW-839). `status` is null when it died on a signal. */
export const execAsync = (file: string, args: string[], opts: ExecFileOptions = {}) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
    execFile(file, args, { ...opts, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({
        status: err ? (typeof err.code === "number" ? err.code : null) : 0,
        stdout,
        stderr,
      }),
    ),
  );
