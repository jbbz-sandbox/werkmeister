/**
 * smoke test that the
 * moved generateWorkspaceCompose still allocates a slot and writes the expected
 * workspace artifacts. allocateSlot is stubbed to avoid shelling out to Docker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../slots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../slots.js")>();
  return { ...actual, allocateSlot: () => 1 };
});

import { generateWorkspaceCompose } from "../generate.js";
import { useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let tmp: string;
let home: SandboxHome;

beforeEach(() => {
  // SANDBOX_ROOT for the templates; a temp ~/.sandbox for the registry.
  process.env.SANDBOX_ROOT = repoRoot;
  home = useSandboxHome();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wscompose-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("generateWorkspaceCompose", () => {
  it("writes the expected files", () => {
    const slot = generateWorkspaceCompose("smoke-test-feature", "frontend", tmp);
    expect(typeof slot).toBe("number");
    expect(fs.statSync(path.join(tmp, "docker-compose.yml")).isFile()).toBe(true);
    expect(fs.statSync(path.join(tmp, ".env")).isFile()).toBe(true);
    expect(fs.statSync(path.join(tmp, ".sandbox", "supergraph-config.yml")).isFile()).toBe(true);
    expect(fs.statSync(path.join(tmp, ".sandbox", "sandbox-context.md")).isFile()).toBe(true);
  });
});
