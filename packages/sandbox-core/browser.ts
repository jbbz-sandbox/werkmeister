/**
 * Feature-tagged Chrome launcher (no Playwright).
 *
 * Launches an isolated Chrome window pre-configured for a sandbox feature and
 * talks to it over the Chrome DevTools Protocol (CDP) using a tiny hand-rolled
 * websocket client (Node stdlib only -- nothing to install).
 *
 * It:
 *   1. Launches Chrome with a throwaway `--user-data-dir` (clean slate, no
 *      saved cookies/history) plus a remote debugging port. The throwaway
 *      profile is what makes CDP reliable -- a normal already-running Chrome
 *      ignores the debug port.
 *   2. Sets the routing cookie `X-Feature=<feature>` on `.local.sandbox.com`.
 *   3. Injects a script into EVERY document (`Page.addScriptToEvaluateOnNewDocument`)
 *      that (a) prefixes the tab/window title with `[feature]` and (b) paints a
 *      fixed, feature-colored badge in the corner -- so the window is identifiable
 *      in the title bar, Mission Control, and Cmd-Tab. The script self-heals on
 *      SPA route changes.
 *
 * The launcher stays attached so new tabs and navigations stay tagged. On Ctrl-C
 * (or window close) it closes Chrome and removes the throwaway profile.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { Colors } from "./colors.js";
import { error, info, raw } from "./reporter.js";
import * as gc from "./global_config.js";
import type { PromptSpec } from "./global_config.js";

export const COOKIE_DOMAIN = ".local.sandbox.com";

// --------------------------------------------------------------------------
// Browser choice
// --------------------------------------------------------------------------
/**
 * Browsers `sandbox setup` can offer for `sandbox open`.
 *
 * `sandbox open` drives the Chrome DevTools Protocol (CDP) over a raw
 * websocket -- only Chromium-engine browsers speak that. Firefox
 * (WebDriver BiDi) and the WebKit browsers (Safari, DuckDuckGo) are listed
 * so they show up as recognized choices, but picking one is a clear error
 * at launch rather than a silent `waitForBrowserWs` timeout.
 */
interface BrowserSpec {
  label: string;
  engine: "chromium" | "webkit" | "gecko";
  macPath: string;
}

export const BROWSERS: Record<string, BrowserSpec> = {
  chrome: {
    label: "Google Chrome",
    engine: "chromium",
    macPath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  chromium: {
    label: "Chromium",
    engine: "chromium",
    macPath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  },
  brave: {
    label: "Brave Browser",
    engine: "chromium",
    macPath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
  edge: {
    label: "Microsoft Edge",
    engine: "chromium",
    macPath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  },
  firefox: {
    label: "Firefox",
    engine: "gecko",
    macPath: "/Applications/Firefox.app/Contents/MacOS/firefox",
  },
  safari: {
    label: "Safari",
    engine: "webkit",
    macPath: "/Applications/Safari.app/Contents/MacOS/Safari",
  },
  duckduckgo: {
    label: "DuckDuckGo",
    engine: "webkit",
    macPath: "/Applications/DuckDuckGo.app/Contents/MacOS/DuckDuckGo",
  },
};

export const DEFAULT_BROWSER = "chrome";

/** `sandbox setup` prompt for `overrides.browser`. */
export const BROWSER_PROMPT: PromptSpec = {
  key: "browser",
  label: "Browser for `sandbox open`",
  help:
    "Chromium browsers (chrome, chromium, brave, edge) work via CDP; safari works via " +
    "Apple's bundled safaridriver. Firefox/DuckDuckGo are listed for visibility but " +
    "aren't wired up yet.",
  acceptEmpty: false,
  pattern: `(${Object.keys(BROWSERS).join("|")})`,
  placeholder: DEFAULT_BROWSER,
  choicesFn: () => Object.keys(BROWSERS),
};

/**
 * Resolve the browser binary to launch.
 *
 * `CHROME_BIN` (a raw path) wins, for CI / non-default installs. Otherwise
 * `overrides.browser_path` (a raw path) wins, then `overrides.browser` (a
 * name from `BROWSERS`) resolves to its default macOS path. Returns null
 * (after printing why) when the choice isn't a Chromium-engine browser.
 */
export function resolveBrowserBinary(): string | null {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;

  const overrides = (gc.load()["overrides"] ?? {}) as Record<string, string>;
  if (overrides.browser_path) return overrides.browser_path;

  const key = overrides.browser || DEFAULT_BROWSER;
  const spec = BROWSERS[key];
  if (!spec) {
    error(`Unknown overrides.browser '${key}' -- choices: ${Object.keys(BROWSERS).join(", ")}`);
    return null;
  }
  if (spec.engine !== "chromium") {
    const engineName = spec.engine === "webkit" ? "WebKit" : "Gecko";
    const chromiumChoices = Object.keys(BROWSERS).filter((k) => BROWSERS[k].engine === "chromium");
    error(
      `${spec.label} uses ${engineName}, not Chromium -- \`sandbox open\` only speaks the ` +
        `Chrome DevTools Protocol, which just Chromium-based browsers support. ` +
        `Run \`sandbox setup\` and pick one of: ${chromiumChoices.join(", ")}.`,
    );
    return null;
  }
  return spec.macPath;
}

// Shared with lib/safari.ts, which has no CDP client of its own to piggyback on.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// Minimal CDP websocket client (stdlib only)
// --------------------------------------------------------------------------
/** A bare-bones text-frame websocket client good enough for CDP. */
export class WS {
  host: string;
  port: number;
  sock: net.Socket;
  /** Set when the connection dies; surfaced by the session run loop. */
  fatalError: Error | null = null;

  private rxbuf: Buffer = Buffer.alloc(0);
  private nextId = 0;
  // Messages decoded before a handler is attached are queued rather than
  // dropped — the handler is set after the socket is already receiving.
  private pending: any[] = [];
  private handler: ((msg: any) => void) | null = null;

  /** Called with each decoded CDP message. */
  set onMessage(fn: ((msg: any) => void) | null) {
    this.handler = fn;
    if (fn) while (this.pending.length) fn(this.pending.shift());
  }

  private constructor(sock: net.Socket, host: string, port: number) {
    this.sock = sock;
    this.host = host;
    this.port = port;
  }

  /** Connect + perform the websocket upgrade handshake. */
  static connect(wsUrl: string): Promise<WS> {
    const u = new URL(wsUrl);
    const host = u.hostname;
    const port = u.port ? parseInt(u.port, 10) : 80;
    let reqPath = u.pathname || "/";
    if (u.search) reqPath += u.search; // URL.search already includes "?"

    return new Promise<WS>((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const ws = new WS(sock, host, port);
      let done = false;
      let buf = Buffer.alloc(0);

      // Handshake phase runs under the 10s connect timeout; the CDP phase
      // blocks indefinitely waiting on events (settimeout(None) equivalent).
      sock.setTimeout(10_000, () => sock.destroy(new Error("websocket handshake timed out")));

      sock.on("error", (err) => {
        if (!done) reject(err);
        else if (!ws.fatalError) ws.fatalError = err;
      });
      sock.on("close", () => {
        if (!done) reject(new Error("websocket handshake failed (closed)"));
        else if (!ws.fatalError) ws.fatalError = new Error("websocket closed by peer");
      });

      const onHandshakeData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString("latin1");
        if (!statusLine.includes(" 101 ")) {
          sock.destroy();
          reject(new Error(`websocket handshake failed: ${buf.subarray(0, 80).toString("latin1")}`));
          return;
        }
        ws.rxbuf = buf.subarray(idx + 4);
        sock.setTimeout(0);
        sock.off("data", onHandshakeData);
        sock.on("data", (c: Buffer) => {
          ws.rxbuf = Buffer.concat([ws.rxbuf, c]);
          ws.pump();
        });
        done = true;
        resolve(ws);
        ws.pump(); // the handshake read may have buffered whole frames already
      };

      sock.on("data", onHandshakeData);
      sock.on("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        const req =
          `GET ${reqPath} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Key: ${key}\r\n` +
          "Sec-WebSocket-Version: 13\r\n\r\n";
        sock.write(req);
      });
    });
  }

  // --- low-level frame I/O -------------------------------------------------
  private sendFrame(payload: Buffer, opcode = 0x1): void {
    const mask = crypto.randomBytes(4);
    const ln = payload.length;
    let header: Buffer;
    if (ln < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | ln]);
    } else if (ln < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(ln, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(ln), 2);
    }
    const masked = Buffer.alloc(ln);
    for (let i = 0; i < ln; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  /** Parse one complete frame off rxbuf, or return null if incomplete. */
  private tryParseFrame(): { opcode: number; payload: Buffer } | null {
    if (this.rxbuf.length < 2) return null;
    const b0 = this.rxbuf[0];
    const b1 = this.rxbuf[1];
    const opcode = b0 & 0x0f;
    let ln = b1 & 0x7f;
    let offset = 2;
    if (ln === 126) {
      if (this.rxbuf.length < 4) return null;
      ln = this.rxbuf.readUInt16BE(2);
      offset = 4;
    } else if (ln === 127) {
      if (this.rxbuf.length < 10) return null;
      ln = Number(this.rxbuf.readBigUInt64BE(2));
      offset = 10;
    }
    // Server->client frames are never masked.
    if (this.rxbuf.length < offset + ln) return null;
    const payload = this.rxbuf.subarray(offset, offset + ln);
    this.rxbuf = this.rxbuf.subarray(offset + ln);
    return { opcode, payload };
  }

  /** Drain complete frames, dispatching text messages to onMessage. */
  private pump(): void {
    for (;;) {
      let frame;
      try {
        frame = this.tryParseFrame();
      } catch (e) {
        this.fatalError = e instanceof Error ? e : new Error(String(e));
        return;
      }
      if (!frame) return;
      const { opcode, payload } = frame;
      if (opcode === 0x8) {
        // close
        this.fatalError = new Error("websocket closed");
        this.sock.destroy();
        return;
      }
      if (opcode === 0x9) {
        // ping -> pong
        this.sendFrame(payload, 0xa);
        continue;
      }
      if (opcode === 0xa) continue; // pong
      // CDP keeps messages small and unfragmented in practice.
      try {
        const msg = JSON.parse(payload.toString("utf8"));
        if (this.handler) this.handler(msg);
        else this.pending.push(msg);
      } catch (e) {
        this.fatalError = e instanceof Error ? e : new Error(String(e));
        return;
      }
    }
  }

  // --- CDP command helpers -------------------------------------------------
  send(method: string, params: Record<string, unknown> | null = null, sessionId: string | null = null): number {
    this.nextId += 1;
    const msg: Record<string, unknown> = { id: this.nextId, method, params: params ?? {} };
    if (sessionId) msg["sessionId"] = sessionId;
    this.sendFrame(Buffer.from(JSON.stringify(msg)));
    return this.nextId;
  }

  close(): void {
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
    } catch {
      /* ignore */
    }
    try {
      this.sock.destroy();
    } catch {
      /* ignore */
    }
  }
}

// --------------------------------------------------------------------------
// Badge / title injection
// --------------------------------------------------------------------------
function sha1Int(s: string): bigint {
  return BigInt("0x" + crypto.createHash("sha1").update(s).digest("hex"));
}

/** Deterministic, readable badge color derived from the feature name. */
export function featureColor(feature: string): string {
  const h = sha1Int(feature);
  const hue = Number(h % 360n);
  const s = 0.65;
  const lum = 0.42; // legible white text on top
  const c = (1 - Math.abs(2 * lum - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lum - c / 2;
  const table: [number, number, number][] = [
    [c, x, 0], [x, c, 0], [0, c, x],
    [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[Math.floor(hue / 60)];
  const hex = (v: number) => Math.trunc((v + m) * 255).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function badgeScript(feature: string, color: string): string {
  const f = JSON.stringify(feature);
  const c = JSON.stringify(color);
  return `
(function(){
  var FEATURE=${f}, COLOR=${c}, TAG="["+FEATURE+"] ";
  function pinTitle(){
    var t=document.title;
    while(t.indexOf(TAG)===0){ t=t.slice(TAG.length); }  // collapse any doubling
    if(!t) return;                                        // wait for a real page title
    var want=TAG+t;
    if(document.title!==want){ document.title=want; }
  }
  function paintBadge(){
    var root=document.documentElement; if(!root) return;
    var id="__sandbox_feature_badge__";
    if(document.getElementById(id)) return;
    var b=document.createElement("div");
    b.id=id; b.textContent="\\u25CF "+FEATURE;
    b.style.cssText="position:fixed;z-index:2147483647;bottom:12px;right:12px;"
      +"background:"+COLOR+";color:#fff;font:600 12px/1.4 -apple-system,system-ui,sans-serif;"
      +"padding:6px 10px;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.35);"
      +"pointer-events:none;letter-spacing:.02em;user-select:none;";
    root.appendChild(b);
  }
  function tick(){ try{pinTitle();paintBadge();}catch(e){} }
  document.addEventListener("DOMContentLoaded",tick);
  tick();
  setInterval(tick,1000);  // self-heal across SPA route changes
})();
`;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
// Shared with lib/safari.ts.
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForBrowserWs(port: number, timeout = 15.0): Promise<string> {
  const deadline = Date.now() + timeout * 1000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      const data = (await r.json()) as { webSocketDebuggerUrl: string };
      return data.webSocketDebuggerUrl;
    } catch (e) {
      last = e;
      await sleep(250);
    }
  }
  throw new Error(`Chrome debug endpoint never came up on :${port} (${last})`);
}

// --------------------------------------------------------------------------
// CDP session: tag every page target with the cookie + badge script
// --------------------------------------------------------------------------
/** Auto-attaches to every page target and applies the feature config. */
class FeatureSession {
  private ws: WS;
  private feature: string;
  private url: string;
  private script: string;
  private procExited: () => boolean;
  private shouldStop: () => boolean;
  private configured = new Set<string>();
  private cookieSet = false;
  private navigated = false;

  constructor(
    ws: WS,
    feature: string,
    color: string,
    url: string,
    procExited: () => boolean,
    shouldStop: () => boolean,
  ) {
    this.ws = ws;
    this.feature = feature;
    this.url = url;
    this.script = badgeScript(feature, color);
    this.procExited = procExited;
    this.shouldStop = shouldStop;
  }

  private configureTarget(sid: string): void {
    // Fire-and-forget: CDP runs per-session commands in order, so we just
    // send and never wait on replies. Waiting (nested ws.call) inside event
    // handling would deadlock -- an inner pump consumes outer replies.
    if (!this.cookieSet) {
      // cookie store is shared per profile; set once
      this.ws.send("Network.enable", null, sid);
      this.ws.send("Network.setCookie", {
        name: "X-Feature", value: this.feature,
        domain: COOKIE_DOMAIN, path: "/",
        secure: true, sameSite: "Lax",
      }, sid);
      this.cookieSet = true;
    }
    this.ws.send("Page.enable", null, sid);
    this.ws.send("Page.addScriptToEvaluateOnNewDocument", { source: this.script }, sid);
    // Tag the current document too (addScript only affects future loads).
    this.ws.send("Runtime.evaluate", { expression: this.script }, sid);
    if (!this.navigated) {
      this.ws.send("Page.navigate", { url: this.url }, sid);
      this.navigated = true;
    }
  }

  onEvent(msg: any): void {
    if (msg?.method !== "Target.attachedToTarget") return;
    const params = msg.params;
    const sid: string = params.sessionId;
    if (params.targetInfo?.type === "page" && !this.configured.has(sid)) {
      this.configured.add(sid);
      try {
        this.configureTarget(sid);
      } catch (e) {
        error(`could not configure tab: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * Auto-attach to every page target (existing + future tabs) and wait for the
   * first one to be configured — cookie set, badge installed, navigation sent.
   *
   * The attach itself is fire-and-forget; the message handler reacts to the
   * resulting `attachedToTarget` events as they arrive on the socket. Returning
   * only once `navigated` flips is what lets a caller distinguish "the window
   * is up and tagged" from "we spawned something".
   */
  async start(timeoutMs = 15_000): Promise<boolean> {
    this.ws.send("Target.setAutoAttach", {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
    });
    this.ws.onMessage = (msg) => this.onEvent(msg);
    const deadline = Date.now() + timeoutMs;
    while (!this.navigated) {
      if (this.ws.fatalError) throw this.ws.fatalError;
      if (this.procExited() || Date.now() > deadline) return false;
      await sleep(50);
    }
    return true;
  }

  /**
   * Stay attached so new tabs and navigations keep getting tagged. Messages are
   * handled by the socket's data events; this loop just polls the Chrome
   * process + stop flag ~1x/sec.
   */
  async poll(): Promise<void> {
    while (!this.procExited() && !this.shouldStop()) {
      if (this.ws.fatalError) throw this.ws.fatalError;
      await sleep(1000);
    }
  }
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------
/**
 * True when the configured browser is Safari *and* nothing forces the raw
 * Chromium/CDP path (`CHROME_BIN`, `overrides.browser_path`) over it. Those
 * two overrides have always meant "launch this literal Chromium-family
 * binary", so they win even if `overrides.browser` happens to say "safari".
 */
function wantsSafari(): boolean {
  if (process.env.CHROME_BIN) return false;
  const overrides = (gc.load()["overrides"] ?? {}) as Record<string, string>;
  if (overrides.browser_path) return false;
  return (overrides.browser || DEFAULT_BROWSER) === "safari";
}

/**
 * A launched, tagged browser window, handed back once it is up.
 *
 * The split exists because the two callers want opposite things from the same
 * window: `sandbox open` blocks on it and cleans up on Ctrl-C, while an
 * in-process caller (the MCP server's open-feature tool) must return
 * immediately and let the window outlive the call. Both still need
 * {@link supervise} to run for the window's life — that is what keeps tabs
 * opened later tagged — so the difference is only whether it is awaited.
 *
 * Signal handling is deliberately NOT in here. It used to be, which meant a
 * library call installed process-wide SIGINT/SIGTERM handlers on whoever
 * imported it; a caller that wants Ctrl-C to close the window wires its own
 * handler to {@link stop}.
 */
export interface FeatureWindow {
  /**
   * Keep tagging new tabs and navigations until the window closes or
   * {@link stop} is called, then close the browser and remove the throwaway
   * profile. Resolves 0 when the window closed on its own, 130 when stopped.
   *
   * Must be called (awaited or not) — it owns the cleanup.
   */
  supervise(): Promise<number>;
  /** Wind {@link supervise} down. Safe to call from a signal handler. */
  stop(): void;
}

/**
 * Launch a feature-tagged browser window, returning once it is up and tagged.
 *
 * Dispatches to Safari's WebDriver client (`safari.ts`) when configured,
 * otherwise the Chromium/CDP client below. Firefox and non-Safari WebKit
 * browsers (DuckDuckGo) aren't wired up to either protocol yet --
 * `resolveBrowserBinary` reports that clearly instead of hanging.
 *
 * Returns null when the launch failed for a reason already reported through the
 * reporter (no usable browser binary, no safaridriver, no WebDriver session).
 */
export async function launchFeatureWindow(
  feature: string,
  url: string,
  opts: { size?: string; position?: string | null } = {},
): Promise<FeatureWindow | null> {
  if (wantsSafari()) {
    const { launchSafariWindow } = await import("./safari.js");
    return launchSafariWindow(feature, url, opts);
  }
  return launchChromiumWindow(feature, url, opts);
}

/** Chromium/CDP launcher -- see the module header for how it works. */
async function launchChromiumWindow(
  feature: string,
  url: string,
  opts: { size?: string; position?: string | null } = {},
): Promise<FeatureWindow | null> {
  const size = opts.size ?? "1440,900";
  let position = opts.position ?? null;

  const CHROME = resolveBrowserBinary();
  if (!CHROME) return null; // resolveBrowserBinary already printed why
  if (!fs.existsSync(CHROME)) {
    error(
      `Browser not found at ${CHROME} (set CHROME_BIN, or overrides.browser_path in ` +
        "config.yaml, to override -- or run `sandbox setup` to pick an installed browser)",
    );
    return null;
  }

  const color = featureColor(feature);
  const port = await findFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `chrome-${feature}-`));

  // Stagger windows so multiple features don't stack exactly.
  if (!position) {
    const off = Number(sha1Int(feature) % 8n) * 40;
    position = `${60 + off},${60 + off}`;
  }

  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    `--window-size=${size}`,
    `--window-position=${position}`,
    "about:blank",
  ];
  // Detached so the window survives the launcher: an in-process caller (the MCP
  // server) hands the window to a human and then returns, and a SIGTERM to that
  // server's process group must not take the browser with it. `cleanup()` kills
  // the pid explicitly, so `sandbox open`'s Ctrl-C still closes it.
  const proc: ChildProcess = spawn(CHROME, chromeArgs, { stdio: "ignore", detached: true });
  proc.unref();
  let procExited = false;
  proc.on("exit", () => {
    procExited = true;
  });

  let ws: WS | null = null;

  async function cleanup(): Promise<void> {
    ws?.close();
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    if (!procExited) {
      const exited = await new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), 5000);
        proc.once("exit", () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      if (!exited) {
        // didn't exit in time; force it
        try {
          proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    fs.rmSync(profile, { recursive: true, force: true });
  }

  let session: FeatureSession;
  let stop = false;
  try {
    ws = await WS.connect(await waitForBrowserWs(port));
    session = new FeatureSession(ws, feature, color, url, () => procExited, () => stop);
    if (!(await session.start())) {
      error("The browser window never came up — nothing was tagged.");
      await cleanup();
      return null;
    }
  } catch (e) {
    // Nobody will call supervise(), so this is the last chance to clean up.
    await cleanup();
    throw e;
  }

  raw("\n");
  info(`Feature : ${feature}`);
  info(`Cookie  : X-Feature=${feature}  (domain ${COOKIE_DOMAIN})`);
  info(`Badge   : ${color}`);
  info(`URL     : ${url}`);
  info(`Profile : ${profile}  (throwaway)`);
  raw(
    `\n  Window is tagged ${Colors.BOLD}[${feature}]${Colors.RESET} ` +
      "in the title bar + corner badge.\n",
  );

  return {
    stop: () => {
      stop = true;
    },
    async supervise(): Promise<number> {
      try {
        await session.poll();
        if (stop) {
          raw("\n");
          info("Closing feature window…");
          return 130;
        }
        return 0;
      } finally {
        await cleanup();
      }
    },
  };
}
