import { createHmac, timingSafeEqual } from "node:crypto";

export const FORWARD = new Set([
  "check_run",
  "workflow_run",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
]);

const SIG = /^sha256=[0-9a-f]{64}$/;

/**
 * @param {{ secret: string | undefined, send: (body: string) => Promise<void> }} deps
 * @returns {(event: { body?: string, isBase64Encoded?: boolean, headers?: Record<string, string> }) => Promise<{ statusCode: number }>}
 */
export function makeHandler({ secret, send }) {
  return async (event) => {
    // An unset secret would make every signature check meaningless.
    if (!secret) return { statusCode: 500 };
    const headers = event.headers ?? {};
    const raw = Buffer.from(event.body ?? "", event.isBase64Encoded ? "base64" : "utf8");
    const sig = headers["x-hub-signature-256"] ?? "";
    if (!SIG.test(sig)) return { statusCode: 401 };
    const expected = Buffer.from(
      `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    );
    if (!timingSafeEqual(Buffer.from(sig), expected)) return { statusCode: 401 };

    const type = headers["x-github-event"] ?? "";
    if (!FORWARD.has(type)) return { statusCode: 204 };
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return { statusCode: 400 };
    }
    const repo = payload?.repository?.full_name;
    if (typeof repo !== "string") return { statusCode: 204 };
    // The payload stays in GitHub: it can pass SQS's 256 KB limit, and the daemon re-reads with gh.
    const body = JSON.stringify({
      delivery: headers["x-github-delivery"] ?? "",
      event: type,
      action: payload.action ?? null,
      repo,
    });
    try {
      await send(body);
    } catch (e) {
      console.error(`send failed: ${e instanceof Error ? e.message : e}`);
      return { statusCode: 500 };
    }
    return { statusCode: 202 };
  };
}

/** @type {import("@aws-sdk/client-sqs").SQSClient | undefined} */
let client;
async function sqsSend(body) {
  // The Lambda Node.js runtime ships AWS SDK v3, so nothing is bundled.
  const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
  client ??= new SQSClient({});
  await client.send(new SendMessageCommand({ QueueUrl: process.env.QUEUE_URL, MessageBody: body }));
}

export const handler = makeHandler({ secret: process.env.WEBHOOK_SECRET, send: sqsSend });
