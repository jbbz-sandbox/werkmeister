import { loadConfig } from "./config.js";
import { INGEST_SECRET_KEYS } from "./global_config.js";
import { getSecretsPath, loadSecrets } from "./secrets.js";

/** The daemon's SQS consumer settings: the `github_ingest:` block of ~/.werkmeister/config.yaml (SW-583). */
export interface GithubIngestConfig {
  queueUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the Lambda puts on the queue: the payload itself stays in GitHub, the daemon re-reads with `gh`. */
export interface IngestMessage {
  delivery: string;
  event: string;
  action: string | null;
  repo: string;
}

/**
 * Null (ingest off) without a `queue_url` or with any field empty. The key pair comes from
 * secrets.env, then config.yaml until `machine config --write` moves it (SW-759). Never shell
 * `AWS_*` keys: they could pair with these or widen the receive/delete-only user's rights.
 */
export function githubIngestConfig(): GithubIngestConfig | null {
  let block: Record<string, unknown>;
  try {
    block = (loadConfig()["github_ingest"] ?? {}) as Record<string, unknown>;
  } catch {
    return null;
  }
  const queueUrl = String(block.queue_url ?? "").trim();
  if (!queueUrl) return null;
  const secrets = loadSecrets(getSecretsPath());
  const key = (k: keyof typeof INGEST_SECRET_KEYS) =>
    String(secrets[INGEST_SECRET_KEYS[k]] || (block[k] ?? "")).trim();
  const cfg = {
    queueUrl,
    region: String(block.region ?? "").trim(),
    accessKeyId: key("access_key_id"),
    secretAccessKey: key("secret_access_key"),
  };
  return Object.values(cfg).every(Boolean) ? cfg : null;
}

export function parseIngestMessage(body: string): IngestMessage | null {
  try {
    const m = JSON.parse(body);
    if (typeof m?.delivery !== "string" || !m.delivery) return null;
    if (typeof m.repo !== "string" || !m.repo) return null;
    return {
      delivery: m.delivery,
      event: String(m.event ?? ""),
      action: typeof m.action === "string" ? m.action : null,
      repo: m.repo,
    };
  } catch {
    return null;
  }
}
