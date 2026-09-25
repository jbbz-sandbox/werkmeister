import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockExec = vi.fn();
const mockExecFile = vi.fn();

vi.mock("child_process", () => ({
  exec: (...args) => mockExec(...args),
  execFile: (...args) => mockExecFile(...args),
}));

vi.mock("os", () => ({
  homedir: () => "/mock/home",
}));

const routerModule = await import("../../../../server/routes/exec.js");
const router = routerModule.default;

// ── App setup ────────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/", router);
  return app;
}

// Helper to save/restore process.platform
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
    configurable: true,
  });
  const restore = () => {
    if (original) {
      Object.defineProperty(process, "platform", original);
    }
  };
  return { restore };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("exec routes", () => {
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    app = buildApp();
  });

  // ── POST / — shellCommand mode ───────────────────────────────────────────
  describe("POST / — shellCommand mode", () => {
    it("runs shellCommand through a shell, pipes and all", async () => {
      mockExec.mockImplementation((cmd, opts, cb) => cb(null, "result", ""));

      const res = await request(app)
        .post("/")
        .send({ shellCommand: "cat file.txt | grep pattern" });

      expect(res.status).toBe(200);
      expect(res.body.stdout).toBe("result");
      expect(mockExec).toHaveBeenCalledWith(
        "cat file.txt | grep pattern",
        expect.objectContaining({ cwd: "/mock/home", timeout: 30000, maxBuffer: 512 * 1024 }),
        expect.any(Function),
      );
    });

    it("uses a shell even for a one-word command — no heuristic remains", async () => {
      const { restore } = withPlatform("linux");
      mockExec.mockImplementation((cmd, opts, cb) => cb(null, "", ""));

      await request(app).post("/").send({ shellCommand: "ls" });
      restore();

      expect(mockExec).toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("rejects the removed `command` field rather than shelling out", async () => {
      const res = await request(app).post("/").send({ command: "ls -la /tmp" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("returns 400 when neither field is present", async () => {
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
    });

    it("returns 400 for an empty shellCommand", async () => {
      const res = await request(app).post("/").send({ shellCommand: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
    });

    it("returns 400 for a non-string shellCommand instead of reaching the shell", async () => {
      const res = await request(app).post("/").send({ shellCommand: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
      expect(mockExec).not.toHaveBeenCalled();
    });
  });

  // ── POST / — argv mode ───────────────────────────────────────────────────
  describe("POST / — argv mode", () => {
    it("runs argv via execFile and never through a shell", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "ok", ""));

      const res = await request(app)
        .post("/")
        .send({ argv: ["git", "status", "--porcelain=v1"] });

      expect(res.status).toBe(200);
      expect(res.body.stdout).toBe("ok");
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["status", "--porcelain=v1"],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("passes a command-substitution branch name as one literal argument", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "checkout", "main$(echo INJECTED)"] });

      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["checkout", "main$(echo INJECTED)"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("keeps a path containing spaces as a single argument", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "add", "--", "my notes/todo list.md"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["add", "--", "my notes/todo list.md"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("passes a leading-dash path through untouched (callers add --)", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "add", "--", "-rf"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["add", "--", "-rf"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses execFile on Windows too — argv has no platform heuristic", async () => {
      const { restore } = withPlatform("win32");
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "out", ""));

      const res = await request(app).post("/").send({ argv: ["dir"] });
      restore();

      expect(res.status).toBe(200);
      expect(mockExecFile).toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("echoes a display string built from argv", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      const res = await request(app)
        .post("/")
        .send({ argv: ["git", "log", "--format=%h|%s"] });

      expect(res.body.command).toBe("git log --format=%h|%s");
    });

    it("honours cwd and the standard exec options", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["ls"], cwd: "/custom/dir" });

      expect(mockExecFile).toHaveBeenCalledWith(
        "ls",
        [],
        expect.objectContaining({
          cwd: "/custom/dir",
          timeout: 30000,
          maxBuffer: 512 * 1024,
        }),
        expect.any(Function),
      );
    });

    it("defaults cwd to homedir", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app).post("/").send({ argv: ["ls"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "ls",
        [],
        expect.objectContaining({ cwd: "/mock/home" }),
        expect.any(Function),
      );
    });

    it("reports the exit code on failure", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) =>
        cb({ code: 128 }, "", "fatal: not a git repository"),
      );

      const res = await request(app).post("/").send({ argv: ["git", "status"] });

      expect(res.status).toBe(200);
      expect(res.body.exitCode).toBe(128);
      expect(res.body.stderr).toBe("fatal: not a git repository");
    });

    // reply() (server/routes/exec.js:10-19) is shared by both branches — these
    // exercised the `err.code ?? 1` and `stdout/stderr || ""` normalization
    // via the deleted legacy string-mode tests. Restored here on argv so the
    // shared helper stays covered now that only argv and shellCommand remain.
    it.each([[undefined], [null]])(
      "defaults exitCode to 1 when err.code is %s",
      async (code) => {
        mockExecFile.mockImplementation((cmd, args, opts, cb) => cb({ code }, "", "boom"));

        const res = await request(app).post("/").send({ argv: ["git", "status"] });

        expect(res.body.exitCode).toBe(1);
      },
    );

    it("normalizes null stdout and stderr to empty strings", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, null, null));

      const res = await request(app).post("/").send({ argv: ["true"] });

      expect(res.body.stdout).toBe("");
      expect(res.body.stderr).toBe("");
    });

    it.each([
      ["a string", { argv: "git status" }],
      ["an empty array", { argv: [] }],
      ["non-string elements", { argv: ["git", 7] }],
      ["a nested array", { argv: ["git", ["status"]] }],
    ])("rejects argv that is %s", async (_label, body) => {
      const res = await request(app).post("/").send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv must be a non-empty array of strings");
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
