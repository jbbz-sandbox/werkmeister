// Token-based authentication for Claudeck
// Zero external dependencies — uses Node.js built-in crypto
import crypto from "crypto";

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function getToken() {
  return process.env.CLAUDECK_TOKEN || null;
}

export function isAuthEnabled() {
  if (process.env.CLAUDECK_AUTH === "false") return false;
  if (process.env.CLAUDECK_AUTH === "true") return true;
  if (process.env.CLAUDECK_TOKEN) return true;
  return false;
}

export function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const pair of cookieHeader.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = val;
  }
  return cookies;
}

export function validateToken(candidate) {
  const stored = getToken();
  if (!stored || !candidate) return false;
  try {
    const a = Buffer.from(String(candidate));
    const b = Buffer.from(String(stored));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // 2. Cookie
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.claudeck_token) {
    return cookies.claudeck_token;
  }
  // Deliberately no query-parameter fallback: URLs reach access logs, browser
  // history and Referer headers. The WebSocket upgrade is the one exception
  // (see wsToken) because a browser cannot set headers on that handshake.
  return null;
}

// ── Host / origin guard ─────────────────────────────────────
// The browser is the attacker's delivery vehicle here: a hostile page can make
// the user's browser talk to this server (DNS rebinding, CSRF). Both defeat the
// localhost bypass below, and auth is off by default, so this guard runs
// regardless of whether auth is enabled.

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

// hostname without port or IPv6 brackets; "" if unparseable.
function hostOf(hostHeader) {
  if (!hostHeader) return "";
  try {
    const h = new URL(`http://${hostHeader}`).hostname.toLowerCase();
    return h.startsWith("[") ? h.slice(1, -1) : h;
  } catch {
    return "";
  }
}

function allowedHosts() {
  return (process.env.CLAUDECK_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => hostOf(h.trim()))
    .filter(Boolean);
}

export function isAllowedHost(req) {
  const host = hostOf(req.headers.host);
  if (!host) return false;
  return LOCAL_HOSTNAMES.has(host) || allowedHosts().includes(host);
}

// A cross-site request is one no page of ours initiated. Top-level GET
// navigations are exempt: they can't read the response, and blocking them
// breaks ordinary links into the app.
export function isCrossSite(req) {
  const isNavigation =
    req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate";

  // Set by the browser, unforgeable by page script: when present it is the
  // whole answer. Origin is not consulted, since a same-origin request may
  // still carry an Origin that differs textually from Host (localhost vs
  // 127.0.0.1, say).
  const site = req.headers["sec-fetch-site"];
  if (site) return site !== "same-origin" && site !== "none" && !isNavigation;

  // Older browsers: fall back to Origin, which is sent on every cross-origin
  // request. Absent on same-origin GETs and on non-browser clients (curl, CLI).
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(req.headers.host).toLowerCase()) {
        return !isNavigation;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export function hostGuard(req, res, next) {
  if (isCrossSite(req)) {
    return res.status(403).json({ error: "Cross-site request blocked" });
  }
  if (isAllowedHost(req)) return next();

  // Reached us under some other name: proxied, tunneled, or rebound onto us by
  // a hostile page. Such a request must carry the token on its own merits.
  if (!isAuthEnabled()) {
    return res.status(403).json({
      error: `Refusing request for host "${req.headers.host || "(none)"}"`,
      hint: "Remote access needs CLAUDECK_TOKEN set. To serve this hostname without auth, list it in CLAUDECK_ALLOWED_HOSTS.",
    });
  }
  if (validateToken(extractToken(req))) return next();

  if ((req.headers.accept || "").includes("text/html")) return res.redirect("/login");
  return res.status(401).json({ error: "Unauthorized" });
}

function isLocalhost(req) {
  // If request has proxy headers, it's being tunneled — not truly local
  if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"]) return false;
  const addr = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function authMiddleware(req, res, next) {
  if (!isAuthEnabled()) return next();

  // Localhost bypass (default on, set CLAUDECK_AUTH_LOCALHOST=true to require auth even on localhost)
  // isAllowedHost guard: a rebound request has a local socket but a foreign Host.
  if (process.env.CLAUDECK_AUTH_LOCALHOST !== "true" && isLocalhost(req) && isAllowedHost(req)) {
    return next();
  }

  const token = extractToken(req);
  if (token && validateToken(token)) return next();

  // For page navigations, redirect to login
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    return res.redirect("/login");
  }

  // For API/asset requests, return 401
  return res.status(401).json({ error: "Unauthorized" });
}

export function verifyWsClient(info, callback) {
  // WebSockets are exempt from CORS, so the Origin/Host checks are the only
  // thing standing between a hostile page and a live session. Always applied.
  if (isCrossSite(info.req)) return callback(false, 403, "Cross-site request blocked");

  const hostOk = isAllowedHost(info.req);
  if (!hostOk && !validateToken(wsToken(info.req))) {
    return callback(false, 401, "Unauthorized");
  }
  if (!isAuthEnabled()) return callback(true);

  // Localhost bypass (skip if proxied)
  const addr = info.req.socket?.remoteAddress || "";
  const isProxied = info.req.headers["x-forwarded-for"] || info.req.headers["x-real-ip"];
  if (process.env.CLAUDECK_AUTH_LOCALHOST !== "true" && !isProxied && hostOk) {
    if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") {
      return callback(true);
    }
  }

  if (validateToken(wsToken(info.req))) return callback(true);

  callback(false, 401, "Unauthorized");
}

// Cookie on the upgrade request, else query string (ws://host/ws?token=xxx).
function wsToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.claudeck_token) return cookies.claudeck_token;
  try {
    return new URL(req.url, "http://localhost").searchParams.get("token");
  } catch {
    return null;
  }
}

// ── Login rate limiting ─────────────────────────────────────
// Scope is deliberately just this endpoint. A 32-byte token is not guessable,
// so this is not the thing standing between an attacker and the app; it is a
// cheap brake on a local process grinding the login form, and it makes
// repeated failures visible in one place.
//
// Only FAILED attempts count, so the legitimate user can never lock themselves
// out by logging in.
//
// ponytail: authMiddleware and verifyWsClient validate tokens on every request
// without passing through here, so a Bearer-header grind is unmetered. Not
// closed deliberately: those paths reject during ordinary use (a stale cookie,
// a fetch racing a logout), and counting those would lock the user out of their
// own machine over an expired cookie. Revisit only if claudeck is ever exposed
// beyond loopback by default.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginAttempts = new Map(); // address → { count, windowStart }

function clientAddress(req) {
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "unknown";
}

function loginRateLimited(address) {
  const entry = loginAttempts.get(address);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(address);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(address) {
  const entry = loginAttempts.get(address);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(address, { count: 1, windowStart: Date.now() });
    return;
  }
  entry.count += 1;
}

/** Test seam — the limiter is module-level state. */
export function __resetLoginAttempts() {
  loginAttempts.clear();
}

export function loginHandler(req, res) {
  if (!isAuthEnabled()) return res.json({ ok: true });

  const address = clientAddress(req);
  if (loginRateLimited(address)) {
    return res.status(429).json({ error: "Too many attempts — try again later" });
  }

  const { token } = req.body || {};
  if (!validateToken(token)) {
    recordLoginFailure(address);
    return res.status(401).json({ error: "Invalid token" });
  }
  loginAttempts.delete(address);
  res.cookie("claudeck_token", token, {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    // A TLS-terminating tunnel leaves req.protocol as http, so the forwarded
    // header is the only signal that the browser's hop was encrypted.
    secure: req.protocol === "https" ||
      String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https",
  });
  res.json({ ok: true });
}

export function statusHandler(_req, res) {
  res.json({ authEnabled: isAuthEnabled() });
}
