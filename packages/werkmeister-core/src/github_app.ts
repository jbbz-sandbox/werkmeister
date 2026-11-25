import { sign } from "node:crypto";
import { loadConfig } from "./config.js";
import { currentLogger } from "./logger.js";
import { getSecretsPath, loadSecrets } from "./secrets.js";

/** The werkmeister GitHub App (SW-584): `github_ingest.app_id` in config.yaml, its key in secrets.env. */
export interface GithubAppConfig {
  appId: string;
  privateKey: string;
}

const API = "https://api.github.com";
// Re-mint this long before expiry, so a long `pr watch` pass never runs on a dying token.
const REFRESH_MS = 5 * 60_000;
// After a refusal, skip the App for this owner this long: one warn per owner, not one per PR per pass.
const RETRY_MS = 10 * 60_000;
// GitHub stalling must not hold the PR status lock: the caller falls back to gh's own login.
const FETCH_TIMEOUT_MS = 10_000;
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** Null when either is missing. secrets.env holds one value per line, so the PEM is stored base64. */
export function githubAppConfig(): GithubAppConfig | null {
  let block: Record<string, unknown>;
  try {
    block = (loadConfig()["github_ingest"] ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const appId = String(block.app_id ?? "").trim();
  const b64 = loadSecrets(getSecretsPath())["GITHUB_APP_PRIVATE_KEY"] ?? "";
  if (!appId || !b64) return null;
  return { appId, privateKey: Buffer.from(b64, "base64").toString("utf8") };
}

function appJwt(cfg: GithubAppConfig, nowMs: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(nowMs / 1000);
  // iat 60 s back absorbs clock drift; GitHub refuses exp more than 10 min out.
  const head = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({ iat: now - 60, exp: now + 540, iss: cfg.appId })}`;
  return `${head}.${sign("RSA-SHA256", Buffer.from(head), cfg.privateKey).toString("base64url")}`;
}

/**
 * An installation token for *repo* (`owner/name`), cached per owner, or null when the App isn't
 * configured or GitHub refuses: the caller then runs as the person. Never logs the key or JWT.
 */
/** Stop using the App for *repo*'s owner for 10 min: a token it minted was refused. */
export function refuseAppToken(repo: string, now = Date.now()): void {
  const owner = repo.split("/")[0]?.toLowerCase();
  if (owner) tokens.set(owner, { token: "", expiresAt: now + REFRESH_MS + RETRY_MS });
}

export async function appInstallationToken(
  repo: string,
  opts: {
    config?: GithubAppConfig | null;
    fetch?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<string | null> {
  const cfg = opts.config === undefined ? githubAppConfig() : opts.config;
  const owner = repo.split("/")[0]?.toLowerCase();
  if (!cfg || !owner || !repo.includes("/")) return null;
  const now = (opts.now ?? Date.now)();
  const cached = tokens.get(owner);
  if (cached && cached.expiresAt - REFRESH_MS > now) return cached.token || null;
  const call = opts.fetch ?? fetch;
  try {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt(cfg, now)}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const inst = await call(`${API}/repos/${repo}/installation`, { headers, signal });
    if (!inst.ok) throw new Error(`GET /repos/${repo}/installation: HTTP ${inst.status}`);
    const { id } = (await inst.json()) as { id: number };
    const res = await call(`${API}/app/installations/${id}/access_tokens`, {
      method: "POST",
      headers,
      signal,
    });
    if (!res.ok) throw new Error(`POST /app/installations/${id}/access_tokens: HTTP ${res.status}`);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
    tokens.set(owner, { token, expiresAt: Date.parse(expires_at) });
    return token;
  } catch (e) {
    // A bad key throws from sign() with OpenSSL text only, no key material.
    currentLogger().warn(
      `GitHub App token for ${repo}: ${(e as Error).message}; using gh's own login`,
    );
    refuseAppToken(repo, now);
    return null;
  }
}
