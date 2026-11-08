import { type GithubIngestConfig, parseIngestMessage } from "werkmeister-core/github_ingest";

export interface QueueMessage {
  Body?: string;
  ReceiptHandle?: string;
}

export interface IngestDeps {
  receive: (req: {
    QueueUrl: string;
    WaitTimeSeconds: number;
    MaxNumberOfMessages: number;
  }) => Promise<QueueMessage[]>;
  remove: (receiptHandle: string) => Promise<void>;
  watch: (opts: { desktop: false; repo: string }) => Promise<{ lines: string[] }>;
  track: <T>(work: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const SEEN_MAX = 1000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

/**
 * SW-583: long-poll the GitHub ingest queue and run one `pr watch` pass per repo a batch names.
 * A message is deleted only after its pass returns, so a throw redelivers it and SQS's redrive
 * moves it to the DLQ; delivery ids are remembered so a redelivery runs no second pass.
 */
export function startGithubIngest(queueUrl: string, deps: IngestDeps): { stop(): void } {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const seen = new Map<string, true>();
  const remember = (id: string) => {
    seen.set(id, true);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
  };
  const removeAll = async (handles: string[]) => {
    for (const h of handles) await deps.remove(h);
  };
  let stopped = false;
  let backoff = 0;

  void (async () => {
    while (!stopped) {
      let batch: QueueMessage[];
      try {
        batch = await deps.receive({
          QueueUrl: queueUrl,
          WaitTimeSeconds: 20,
          MaxNumberOfMessages: 10,
        });
        backoff = 0;
      } catch (e) {
        backoff = Math.min(backoff ? backoff * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
        deps.log(
          `github ingest: receive failed: ${(e as Error).message}; retry in ${backoff / 1000}s`,
        );
        await sleep(backoff);
        continue;
      }
      const byRepo = new Map<string, { handles: string[]; ids: string[]; label: string }>();
      for (const m of batch) {
        if (!m.ReceiptHandle) continue;
        const msg = parseIngestMessage(m.Body ?? "");
        if (!msg) {
          deps.log(`github ingest: dropped a malformed message: ${(m.Body ?? "").slice(0, 200)}`);
          await deps.remove(m.ReceiptHandle).catch(() => {});
          continue;
        }
        if (seen.has(msg.delivery)) {
          await deps.remove(m.ReceiptHandle).catch(() => {});
          continue;
        }
        const key = msg.repo.toLowerCase();
        const group = byRepo.get(key) ?? {
          handles: [],
          ids: [],
          label: `${msg.event}/${msg.action ?? "-"} on ${msg.repo} (${msg.delivery})`,
        };
        group.handles.push(m.ReceiptHandle);
        group.ids.push(msg.delivery);
        byRepo.set(key, group);
      }
      for (const [repo, g] of byRepo) {
        try {
          const r = await deps.track(() => deps.watch({ desktop: false, repo }));
          deps.log(`github ingest: ${g.label}: ${r.lines[0] ?? "pass ran"}`);
          await removeAll(g.handles);
          for (const id of g.ids) remember(id);
        } catch (e) {
          deps.log(
            `github ingest: ${g.label}: pass failed, left for redelivery: ${(e as Error).message}`,
          );
        }
      }
    }
  })();

  return {
    stop() {
      stopped = true;
    },
  };
}

/** The real SQS calls for {@link startGithubIngest}; the SDK loads only when ingest is configured. */
export async function sqsDeps(
  cfg: GithubIngestConfig,
): Promise<Pick<IngestDeps, "receive" | "remove">> {
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import(
    "@aws-sdk/client-sqs"
  );
  const client = new SQSClient({
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return {
    receive: async (req) => (await client.send(new ReceiveMessageCommand(req))).Messages ?? [],
    remove: async (h) => {
      await client.send(new DeleteMessageCommand({ QueueUrl: cfg.queueUrl, ReceiptHandle: h }));
    },
  };
}
