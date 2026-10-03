/**
 * `sandbox detect` end to end through runDetect with injected tools, so
 * nothing shells out to git or helm and nothing talks to Claude.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { Answer, Resolver } from "sandbox-core/fragment_detect";
import type { Runner } from "sandbox-core/machine_setup";
import { runDetect, type DetectDeps } from "../../commands/detect.js";

const noTools: Runner = (cmd) => (cmd[0] === "git" ? [128, "fatal: not a git repository"] : [127, `${cmd[0]}: command not found`]);

function repo(files: Record<string, string>): { root: string; reposRoot: string } {
  const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "detect-cmd-"));
  const root = path.join(reposRoot, "shop");
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return { root, reposRoot };
}

const NODE_APP = {
  "package.json": JSON.stringify({ name: "shop", scripts: { dev: "node server.js", test: "node --test" }, dependencies: { express: "4" } }),
  "Dockerfile": "FROM node:22-alpine\nEXPOSE 8080\nCMD [\"node\", \"server.js\"]\n",
};
const GO_APP = { "services/api/Dockerfile": "FROM golang:1.23\nEXPOSE 9000\nCMD [\"/app/api\"]\n" };

function deps(reposRoot: string, over: Partial<DetectDeps> = {}): DetectDeps {
  return {
    runner: noTools,
    resolver: async () => [],
    interactive: false,
    reposRoot,
    localPath: path.join(reposRoot, "no-local.yaml"),
    portsPerSlot: 20,
    cwd: reposRoot,
    ...over,
  };
}
const args = (over: Partial<{ repo: string | null; dryRun: boolean; yes: boolean; assist: boolean | undefined }> = {}) => ({
  repo: "shop", dryRun: false, yes: false, assist: undefined, ...over,
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("sandbox detect", () => {
  it("--dry-run reports and writes nothing", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ dryRun: true }), deps(reposRoot))).toBe(0);
    expect(fs.existsSync(path.join(root, ".sandbox/services.yaml"))).toBe(false);
  });

  it("without a TTY and without --yes it writes nothing", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args(), deps(reposRoot))).toBe(0);
    expect(fs.existsSync(path.join(root, ".sandbox/services.yaml"))).toBe(false);
  });

  it("--yes writes a runnable fragment, and a second run is a no-op", async () => {
    const { root, reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(0);
    const file = path.join(root, ".sandbox/services.yaml");
    const first = fs.readFileSync(file, "utf8");
    expect(first).toContain("internal_port: 8080");
    expect(first).toContain("command: exec npm run dev");
    expect(first).toContain("shop-install:");
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe(first);
  });

  it("--assist sends the guesses to the resolver and writes its answers as inferred", async () => {
    const { root, reposRoot } = repo(GO_APP);
    const resolver = vi.fn<Resolver>(async (_root, questions) => {
      expect(questions.map((q) => q.id)).toContain("api.command");
      return [{ item: "api.command", value: "cd services/api && exec go run .", reason: "README dev section", files_read: ["README.md"] } satisfies Answer];
    });
    expect(await runDetect(args({ yes: true, assist: true }), deps(reposRoot, { resolver }))).toBe(0);
    expect(resolver).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(root, ".sandbox/services.yaml"), "utf8")).toContain(
      "command: cd services/api && exec go run . # inferred by Claude: README dev section",
    );
  });

  it("a failing resolver keeps the deterministic guesses and still writes", async () => {
    const { root, reposRoot } = repo(GO_APP);
    const resolver: Resolver = async () => {
      throw new Error("not logged in");
    };
    expect(await runDetect(args({ yes: true, assist: true }), deps(reposRoot, { resolver }))).toBe(0);
    expect(fs.readFileSync(path.join(root, ".sandbox/services.yaml"), "utf8")).toContain("# guessed:");
  });

  it("--dry-run never calls the resolver, even with --assist", async () => {
    const { reposRoot } = repo(GO_APP);
    const resolver = vi.fn<Resolver>(async () => []);
    await runDetect(args({ dryRun: true, assist: true }), deps(reposRoot, { resolver }));
    expect(resolver).not.toHaveBeenCalled();
  });

  it("with no repo argument outside a git repo it exits 2", async () => {
    const { reposRoot } = repo(NODE_APP);
    expect(await runDetect(args({ repo: null }), deps(reposRoot))).toBe(2);
  });

  it("a repo with nothing to detect exits 1 and writes nothing", async () => {
    const { root, reposRoot } = repo({ "README.md": "hi" });
    expect(await runDetect(args({ yes: true }), deps(reposRoot))).toBe(1);
    expect(fs.existsSync(path.join(root, ".sandbox"))).toBe(false);
  });
});
