/**
 * Safari launcher for `sandbox open`, via Apple's bundled `safaridriver`
 * (W3C WebDriver classic) -- Safari has no CDP, so this is a separate
 * protocol client from the Chromium one in `browser.ts`.
 *
 * Differences from the Chromium/CDP path, inherent to WebDriver rather than
 * bugs to fix later:
 *   - safaridriver launches and owns the Safari process itself; there's no
 *     `--user-data-dir` equivalent, so the session runs in Safari's normal
 *     profile/cookies rather than a throwaway one.
 *   - WebDriver has no "run this script on every future document" hook like
 *     CDP's `Page.addScriptToEvaluateOnNewDocument`. Instead this polls each
 *     open tab's URL once a second (the same cadence the badge script's own
 *     self-heal `setInterval` already uses) and re-injects the badge script
 *     whenever a tab is new or has navigated to a new document. In-page SPA
 *     route changes don't need this -- the injected script self-heals those
 *     on its own once it's running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";

import { error, info } from "./config.js";
import { badgeScript, COOKIE_DOMAIN, featureColor, findFreePort, sleep } from "./browser.js";

const SAFARIDRIVER = "/usr/bin/safaridriver";

/** Parsed `--window-size`/`--window-position` strings into a WebDriver rect. */
export function parseRect(
  size: string,
  position: string | null,
): { width: number; height: number; x: number; y: number } {
  const [width, height] = size.split(",").map(Number);
  const [x, y] = (position ?? "60,60").split(",").map(Number);
  return { width, height, x, y };
}

async function wdFetch(port: number, path: string, method: string, body?: unknown): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}) as any);
  if (!r.ok || data?.value?.error) {
    const msg = data?.value?.message || data?.value?.error || `HTTP ${r.status}`;
    throw new Error(`safaridriver ${method} ${path} failed: ${msg}`);
  }
  return data.value;
}

/** Wait for safaridriver's HTTP server to accept connections on *port*. */
async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(200);
  }
  throw new Error(`safaridriver never came up on :${port}`);
}

/**
 * Launch a feature-tagged Safari window via safaridriver. Blocks until closed.
 *
 * Returns a process exit code (0 on clean exit).
 */
export async function openSafariBrowser(
  feature: string,
  url: string,
  opts: { size?: string; position?: string | null } = {},
): Promise<number> {
  if (!fs.existsSync(SAFARIDRIVER)) {
    error(`safaridriver not found at ${SAFARIDRIVER} -- this needs macOS with Safari installed.`);
    return 1;
  }

  const rect = parseRect(opts.size ?? "1440,900", opts.position ?? null);
  const color = featureColor(feature);
  const port = await findFreePort();
  const script = badgeScript(feature, color);

  const driver: ChildProcess = spawn(SAFARIDRIVER, [`--port=${port}`], { stdio: "ignore" });
  let driverExited = false;
  driver.on("exit", () => {
    driverExited = true;
  });

  let stop = false;
  const onSignal = () => {
    stop = true;
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let sessionId: string | null = null;
  try {
    await waitForPort(port);

    try {
      const session = await wdFetch(port, "/session", "POST", {
        capabilities: { alwaysMatch: { browserName: "safari" } },
      });
      sessionId = session.sessionId;
    } catch (e) {
      error(`Could not start a Safari WebDriver session: ${e instanceof Error ? e.message : e}`);
      error(
        "One-time setup: run `safaridriver --enable` (needs sudo), then in Safari enable " +
          'Settings > Advanced > "Show features for web developers", and ' +
          'Develop > "Allow Remote Automation".',
      );
      return 1;
    }

    console.log();
    info(`Feature : ${feature}`);
    info(`Cookie  : X-Feature=${feature}  (domain ${COOKIE_DOMAIN})`);
    info(`Badge   : ${color}`);
    info(`URL     : ${url}`);
    info("Profile : Safari's normal profile (safaridriver has no throwaway-profile option)");
    console.log(`\n  Window is tagged [${feature}] in the title bar + corner badge.`);
    console.log("  Ctrl-C to close the window and clean up.\n");

    await wdFetch(port, `/session/${sessionId}/window/rect`, "POST", rect);

    // Land on the domain root before the real navigation so the routing
    // cookie is present for the very first request to the real URL --
    // WebDriver's Add Cookie requires being on a matching origin already,
    // unlike CDP's Network.setCookie which can set it ahead of navigation.
    const origin = new URL(url).origin + "/";
    await wdFetch(port, `/session/${sessionId}/url`, "POST", { url: origin });
    await wdFetch(port, `/session/${sessionId}/cookie`, "POST", {
      cookie: {
        name: "X-Feature",
        value: feature,
        domain: COOKIE_DOMAIN.replace(/^\./, ""),
        path: "/",
        secure: true,
        sameSite: "Lax",
      },
    });
    await wdFetch(port, `/session/${sessionId}/url`, "POST", { url });

    const taggedUrl = new Map<string, string>(); // handle -> last-tagged URL
    async function tagHandle(handle: string): Promise<void> {
      await wdFetch(port, `/session/${sessionId}/window`, "POST", { handle });
      const curUrl = await wdFetch(port, `/session/${sessionId}/url`, "GET");
      await wdFetch(port, `/session/${sessionId}/execute/sync`, "POST", { script, args: [] });
      taggedUrl.set(handle, curUrl);
    }

    const initialHandles: string[] = await wdFetch(port, `/session/${sessionId}/window/handles`, "GET");
    for (const h of initialHandles) await tagHandle(h);

    // Poll every tab; tag anything new or that navigated to a fresh document
    // (a new document has no injected script -- in-page SPA routing does,
    // via the script's own self-heal interval, so it's left alone).
    while (!driverExited && !stop) {
      await sleep(1000);
      let handles: string[];
      try {
        handles = await wdFetch(port, `/session/${sessionId}/window/handles`, "GET");
      } catch {
        break; // session/driver gone
      }
      if (!Array.isArray(handles)) continue; // transient malformed response -- try again next tick
      for (const h of handles) {
        try {
          await wdFetch(port, `/session/${sessionId}/window`, "POST", { handle: h });
          const curUrl = await wdFetch(port, `/session/${sessionId}/url`, "GET");
          if (taggedUrl.get(h) !== curUrl) await tagHandle(h);
        } catch {
          continue; // tab closed mid-poll
        }
      }
    }

    if (stop) {
      console.log();
      info("Closing feature window…");
      return 130;
    }
    return 0;
  } finally {
    if (sessionId) {
      try {
        await wdFetch(port, `/session/${sessionId}`, "DELETE");
      } catch {
        /* ignore */
      }
    }
    try {
      driver.kill();
    } catch {
      /* ignore */
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
