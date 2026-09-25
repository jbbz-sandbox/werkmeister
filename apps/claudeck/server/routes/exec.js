import { Router } from "express";
import { exec, execFile } from "child_process";
import { homedir } from "os";

const router = Router();

const EXEC_OPTS = { timeout: 30000, maxBuffer: 512 * 1024 };

// `display` is echoed back for the UI only — it is never executed.
function reply(res, display) {
  return (err, stdout, stderr) => {
    res.json({
      command: display,
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: err ? (err.code ?? 1) : 0,
    });
  };
}

router.post("/", (req, res) => {
  const { command, argv, cwd } = req.body;
  const opts = { ...EXEC_OPTS, cwd: cwd || homedir() };

  // argv mode: no shell, ever. Arguments reach the program exactly as given,
  // so repository data (branch names, paths, commit messages) cannot be read
  // as syntax. Callers pass `--` before any path that could start with a dash.
  if (argv !== undefined) {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((a) => typeof a === "string")
    ) {
      return res.status(400).json({ error: "argv must be a non-empty array of strings" });
    }
    return execFile(argv[0], argv.slice(1), opts, reply(res, argv.join(" ")));
  }

  if (!command) return res.status(400).json({ error: "command is required" });

  // Legacy string mode — removed in Task 3 once every caller uses argv.
  const parts = command.split(/\s+/);
  const isSimple =
    parts.length <= 2 &&
    !command.includes("|") &&
    !command.includes(">") &&
    !command.includes("&");
  if (isSimple && process.platform !== "win32") {
    execFile(parts[0], parts.slice(1), opts, reply(res, command));
  } else {
    exec(command, opts, reply(res, command));
  }
});

export default router;
