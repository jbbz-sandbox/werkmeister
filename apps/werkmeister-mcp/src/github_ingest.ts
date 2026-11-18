import { type GithubIngestConfig, parseIngestMessage } from "werkmeister-core/github_ingest";

/** One event off a transport: its raw body, and `ack` to tell the transport it was handled. */
export interface SourceMessage {
  body: string;
  ack: () => Promise<void>;
}

/**
 * SW-879: where PR events come from (SQS today; smee.io or Pub/Sub later). `receive` waits for
 * the next batch (may return []); an un-acked message must come back later, so a failed pass retries.
 */
export interface EventSource {
  receive: () => Promise<SourceMessage[]>;
}

export interface IngestDeps {
  watch: (opts: { desktop: false; repo: string }) => Promise<{ lines: string[] }>;
  track: <T>(work: () => Promise<T>) => Promise<T>;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const SEEN_MAX = 1000;
const BACKOFF_MIN_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

/**
 * SW-583: pull GitHub events off `source` and run one `pr watch` pass per repo a batch names.
 * A message is acked only after its pass returns, so a throw leaves it for redelivery;
 * delivery ids are remembered so a redelivery runs no second pass.
 */
export function startGithubIngest(source: EventSource, deps: IngestDeps): { stop(): void } {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  const seen = new Map<string, true>();
  const remember = (id: string) => {
    seen.set(id, true);
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value as string);
  };
  const ackAll = async (msgs: SourceMessage[]) => {
    for (const m of msgs) await m.ack();
  };
  let stopped = false;
  let backoff = 0;

  void (async () => {
    while (!stopped) {
      let batch: SourceMessage[];
      try {
        batch = await source.receive();
        backoff = 0;
      } catch (e) {
        backoff = Math.min(backoff ? backoff * 2 : BACKOFF_MIN_MS, BACKOFF_MAX_MS);
        deps.log(
          `github ingest: receive failed: ${(e as Error).message}; retry in ${backoff / 1000}s`,
        );
        await sleep(backoff);
        continue;
      }
      const byRepo = new Map<string, { msgs: SourceMessage[]; ids: string[]; label: string }>();
      for (const m of batch) {
        const msg = parseIngestMessage(m.body);
        if (!msg) {
          deps.log(`github ingest: dropped a malformed message: ${m.body.slice(0, 200)}`);
          await m.ack().catch(() => {});
          continue;
        }
        if (seen.has(msg.delivery)) {
          await m.ack().catch(() => {});
          continue;
        }
        const key = msg.repo.toLowerCase();
        const group = byRepo.get(key) ?? {
          msgs: [],
          ids: [],
          label: `${msg.event}/${msg.action ?? "-"} on ${msg.repo} (${msg.delivery})`,
        };
        group.msgs.push(m);
        group.ids.push(msg.delivery);
        byRepo.set(key, group);
      }
      for (const [repo, g] of byRepo) {
        try {
          const r = await deps.track(() => deps.watch({ desktop: false, repo }));
          deps.log(`github ingest: ${g.label}: ${r.lines[0] ?? "pass ran"}`);
          await ackAll(g.msgs);
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

/** The SQS {@link EventSource}: 20 s long polls, ack deletes. The SDK loads only when ingest is configured. */
export async function sqsSource(
  cfg: GithubIngestConfig,
  client?: {
    send: (command: object) => Promise<{ Messages?: { Body?: string; ReceiptHandle?: string }[] }>;
  },
): Promise<EventSource> {
  const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = await import(
    "@aws-sdk/client-sqs"
  );
  const sqs =
    client ??
    new SQSClient({
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  return {
    receive: async () => {
      const { Messages = [] } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: cfg.queueUrl,
          WaitTimeSeconds: 20,
          MaxNumberOfMessages: 10,
        }),
      );
      return Messages.flatMap(({ Body, ReceiptHandle }) =>
        ReceiptHandle
          ? [
              {
                body: Body ?? "",
                ack: async () => {
                  await sqs.send(
                    new DeleteMessageCommand({ QueueUrl: cfg.queueUrl, ReceiptHandle }),
                  );
                },
              },
            ]
          : [],
      );
    },
  };
}
