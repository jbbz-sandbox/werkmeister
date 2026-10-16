/** `resolveBrowserBinary` — CHROME_BIN / overrides.browser_path / overrides.browser resolution. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BROWSERS, resolveBrowserBinary } from "sandbox-core/browser";
import * as gc from "sandbox-core/global_config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "browser-cfg-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "config.yaml");
  delete process.env.CHROME_BIN;
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  delete process.env.CHROME_BIN;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("resolveBrowserBinary", () => {
  it("defaults to chrome when nothing is configured", () => {
    expect(resolveBrowserBinary()).toBe(BROWSERS.chrome.macPath);
  });

  it("overrides.browser picks another Chromium-engine browser", () => {
    gc.save({ overrides: { browser: "brave" } });
    expect(resolveBrowserBinary()).toBe(BROWSERS.brave.macPath);
  });

  it("overrides.browser_path wins over overrides.browser", () => {
    gc.save({ overrides: { browser: "brave", browser_path: "/custom/brave" } });
    expect(resolveBrowserBinary()).toBe("/custom/brave");
  });

  it("CHROME_BIN wins over everything", () => {
    gc.save({ overrides: { browser: "brave", browser_path: "/custom/brave" } });
    process.env.CHROME_BIN = "/custom/chrome-bin";
    expect(resolveBrowserBinary()).toBe("/custom/chrome-bin");
  });

  it("a non-Chromium engine (firefox, safari, duckduckgo) errors instead of hanging", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const key of ["firefox", "safari", "duckduckgo"]) {
      gc.save({ overrides: { browser: key } });
      expect(resolveBrowserBinary()).toBeNull();
    }
  });

  it("an unknown browser name errors", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    gc.save({ overrides: { browser: "netscape" } });
    expect(resolveBrowserBinary()).toBeNull();
  });
});
