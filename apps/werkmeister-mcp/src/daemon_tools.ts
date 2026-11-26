/**
 * The CLI verbs that had no tool (clean, stats, optimize, cache, registry) and
 * the reads the workspaces views poll (resources, budget, intercepts), so a thin
 * client never needs Docker or telepresence in its own process (SW-184).
 * Same adapter as tools.ts: the CLI's transcript as `content`, the core result
 * as `structuredContent`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { budgetStatus } from "werkmeister-core/budget_status";
import { pruneCaches } from "werkmeister-core/build_caches";
import { containerStats } from "werkmeister-core/docker";
import {
  admitOrQueue,
  grantInBackground,
  grantWaiters,
  planClean,
  runClean,
} from "werkmeister-core/lifecycle";
import {
  METRICS_RANGES,
  type MetricsRange,
  metricsReport,
  metricsTrends,
  TREND_BUCKETS,
  type TrendBucket,
} from "werkmeister-core/metrics_report";
import { syncRegistry } from "werkmeister-core/registry_sync";
import { getWorkspaceResources } from "werkmeister-core/resources";
import { waitingQueue } from "werkmeister-core/scheduler_client";
import { allocateSlot, releaseSlot, slotLease } from "werkmeister-core/slots";
import { optimizeReport, runCollection } from "werkmeister-core/stats";
import { interceptsSnapshot } from "werkmeister-core/status";
import { z } from "zod";

import { adapt } from "./tools.js";

const DRY_RUN = z
  .boolean()
  .optional()
  .describe("Report what would happen without changing anything. Default true.");

const COLLECT = {
  collect: z
    .number()
    .nonnegative()
    .optional()
    .describe("Minutes to sample for before reporting. Default 0: one snapshot."),
  interval: z.number().int().positive().optional().describe("Seconds between samples. Default 10."),
};

const MINUTES = z.number().nullable();
const WAITS = z.object({
  person: z.number(),
  capacity: z.number(),
  pr: z.number(),
  gateRetry: z.number(),
  release: z.number(),
});
const PERCENTILES = z.object({ p50Minutes: MINUTES, p90Minutes: MINUTES });
const TOKENS = z.object({
  input: z.number(),
  output: z.number(),
  cacheCreation: z.number(),
  cacheRead: z.number(),
});
const BY_MODEL = z.record(z.string(), z.object({ tokens: TOKENS, estUsd: z.number().nullable() }));
const USAGE_ROLLUP = z.object({
  workspaces: z.number(),
  estUsd: z.number().nullable(),
  costUnknown: z.number(),
  tokens: TOKENS,
  cacheReadShare: z.number().nullable(),
  activeMinutes: z.number(),
  wallClockMinutes: z.number(),
  turns: z.number(),
});
const METRICS_OUTPUT = {
  range: z.enum(METRICS_RANGES as [MetricsRange, ...MetricsRange[]]),
  from: z.string().nullable(),
  to: z.string(),
  board: z.array(
    z.object({
      column: z.enum(["working", "ready", "pr-open", "awaiting-release"]),
      wip: z.number(),
      p50Minutes: MINUTES,
      p90Minutes: MINUTES,
      cards: z.array(
        z.object({
          workspace: z.string(),
          ticket: z.string().nullable(),
          stage: z.object({ index: z.number(), total: z.number(), name: z.string() }).nullable(),
          enteredAt: z.string().nullable(),
          ageMinutes: MINUTES,
          overP90: z.boolean(),
          wait: z
            .object({
              cause: z.enum(["person", "capacity", "pr", "gateRetry", "release"]),
              since: z.string(),
              minutes: z.number(),
            })
            .nullable(),
        }),
      ),
    }),
  ),
  waitsByWeek: z.array(z.object({ week: z.string(), seconds: WAITS })),
  agentByDay: z.array(z.object({ day: z.string(), activeMinutes: z.number() })),
  waits: WAITS,
  tickets: z.array(
    z.object({
      ticket: z.string(),
      workspace: z.string(),
      firstTurn: z.string(),
      inProgressAt: z.string().nullable(),
      mergedAt: z.string(),
      releasedAt: z.string().nullable(),
      cycleMinutes: z.number(),
      leadMinutes: z.number(),
    }),
  ),
  cycle: PERCENTILES,
  lead: PERCENTILES,
  releases: z.object({
    total: z.number(),
    byWeek: z.array(z.object({ week: z.string(), count: z.number() })),
  }),
  usage: USAGE_ROLLUP.extend({
    byPerson: z.record(z.string(), USAGE_ROLLUP.extend({ lead: PERCENTILES })),
    byProject: z.record(z.string(), USAGE_ROLLUP),
    byModel: BY_MODEL,
  }),
  gate: z.object({
    firstPassRate: z.number().nullable(),
    passed: z.number(),
    workspaces: z.number(),
  }),
  timeline: z
    .array(
      z.object({
        at: z.string(),
        event: z.string(),
        stage: z.string().optional(),
        waitedS: z.number().optional(),
        exit: z.number().optional(),
        pr: z.string().optional(),
      }),
    )
    .optional(),
};
const COUNTED = PERCENTILES.extend({ count: z.number() });
const TREND_SLICE = z.object({
  shipped: z.number(),
  abandoned: z.number(),
  stages: z.record(
    z.string(),
    COUNTED.extend({
      totalMinutes: z.number(),
      personMinutes: z.number(),
      capacityMinutes: z.number(),
      workingMinutes: z.number(),
    }),
  ),
  slowest: z.array(
    z.object({
      ticket: z.string(),
      workspace: z.string(),
      leadToMergeMinutes: z.number().nullable(),
      leadToReleaseMinutes: z.number().nullable(),
    }),
  ),
  leadToMerge: COUNTED,
  leadToRelease: COUNTED,
  tokens: TOKENS,
  estUsd: z.number().nullable(),
  costUnknown: z.number(),
  byModel: BY_MODEL,
  cacheReadShare: z.number().nullable(),
  activeMinutes: z.number(),
  wallClockMinutes: z.number(),
  gate: z.object({
    runs: z.number(),
    wallMinutes: z.number(),
    firstPassRate: z.number().nullable(),
    passed: z.number(),
    workspaces: z.number(),
    byKind: z.record(z.string(), z.number()),
  }),
  tests: z.record(z.string(), COUNTED.extend({ cached: z.number(), failed: z.number() })),
});
const TRENDS_OUTPUT = {
  range: z.enum(METRICS_RANGES as [MetricsRange, ...MetricsRange[]]),
  bucket: z.enum(TREND_BUCKETS as [TrendBucket, ...TrendBucket[]]),
  from: z.string().nullable(),
  to: z.string(),
  suites: z.record(z.string(), COUNTED),
  suitesByVersion: z.record(z.string(), z.record(z.string(), COUNTED)),
  rows: z.array(
    TREND_SLICE.extend({ bucket: z.string(), byVersion: z.record(z.string(), TREND_SLICE) }),
  ),
};

export function registerDaemonTools(server: McpServer): void {
  server.registerTool(
    "clean",
    {
      title: "Remove orphaned volumes and stale slots",
      annotations: { readOnlyHint: false },
      description:
        "`werkmeister machine clean`: remove Docker volumes and slot entries whose feature is gone. " +
        "Dry run unless `dryRun: false`. With `all`, tears down active features first.",
      inputSchema: {
        all: z.boolean().optional().describe("Also tear down active features. Default false."),
        dryRun: DRY_RUN,
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => {
        const all = args.all ?? false;
        return { ...(await (args.dryRun === false ? runClean({ all }) : planClean({ all }))) };
      }),
  );

  server.registerTool(
    "stats",
    {
      title: "Container resource usage",
      annotations: { readOnlyHint: false },
      description:
        "`werkmeister machine stats`: CPU and memory per container, now or sampled over `collect` " +
        "minutes with recommended limits.",
      inputSchema: {
        ...COLLECT,
        save: z
          .boolean()
          .optional()
          .describe("Write the collected report to stats/. Default false."),
      },
    },
    async (args, extra): Promise<CallToolResult> =>
      adapt(async () => {
        if (!args.collect) return { containers: await containerStats(extra.signal) };
        return {
          ...(await runCollection(
            args.collect,
            args.interval ?? 10,
            args.save ?? false,
            extra.signal,
          )),
        };
      }),
  );

  server.registerTool(
    "optimize",
    {
      title: "Usage against configured limits",
      annotations: { readOnlyHint: true },
      description:
        "`werkmeister machine optimize`: each service's observed memory against its configured limit, " +
        "flagging the ones at risk or over-provisioned.",
      inputSchema: { ...COLLECT },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({ ...(await optimizeReport(args.collect ?? 0, args.interval ?? 10)) })),
  );

  server.registerTool(
    "metrics",
    {
      title: "Flow metrics",
      annotations: { readOnlyHint: true },
      description:
        "Where work waits, over a range (default 7d): the flow board of open workspaces (working with " +
        "its ICM stage, ready, pr-open, awaiting-release) with each card's age and current wait, each " +
        "column's age p50/p90, waits by cause per ISO week in seconds (person, capacity, pr open → " +
        "merge, gateRetry, release), cycle and lead time per ticket, and cost, tokens, active and wall " +
        "time, turns and gate first-pass rate for workspaces closed in the range. With a workspace, also " +
        "that workspace's run as a timeline: stage.done, waits, gate runs, PR open, merge and release. Reads the metrics " +
        "event log, workspace state and usage.json from the record branches on this machine.",
      inputSchema: {
        range: z
          .enum(METRICS_RANGES as [MetricsRange, ...MetricsRange[]])
          .optional()
          .describe("7d, 30d, 90d or all. Default 7d."),
        workspace: z.string().optional().describe("A workspace name: adds its run's timeline."),
      },
      outputSchema: METRICS_OUTPUT,
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({
        ...(await metricsReport({ range: args.range, workspace: args.workspace })),
      })),
  );

  server.registerTool(
    "metrics-trends",
    {
      title: "Metrics trends",
      annotations: { readOnlyHint: true },
      description:
        "The same work over time, one row per day or ISO week (Monday, UTC) over a range (default 30d, " +
        "week): shipped and abandoned workspaces, minutes per ICM stage (p50, p90, count, and summed " +
        "total, waiting on a person, waiting on capacity and working), lead time from the first turn to " +
        "merge and to release (p50, p90) with the five slowest tickets, tokens and estimated cost in total and by " +
        "model, cache-read share, active and wall minutes, and gate runs, gate minutes (also by row kind: " +
        "setup, lint, test, release, checks) and first-pass rate (exit-75 capacity retries left out), and " +
        "test minutes per package (p50, p90, count, cached and failed runs; cached runs left out of the " +
        "percentiles), with suites: the same per package over the whole range, for the slowest suites. Each item counts in the bucket it ended in: a workspace by " +
        "its close-out, a stage when it finished, a lead time at its merge or release, a gate run at its " +
        "end. Every row also has byVersion: the same numbers per werkmeister version from each " +
        "workspace's usage.json, `unknown` when it has none. Reads the metrics event log, workspace state " +
        "and usage.json from the record branches on this machine.",
      inputSchema: {
        range: z
          .enum(METRICS_RANGES as [MetricsRange, ...MetricsRange[]])
          .optional()
          .describe("7d, 30d, 90d or all. Default 30d."),
        bucket: z
          .enum(TREND_BUCKETS as [TrendBucket, ...TrendBucket[]])
          .optional()
          .describe("day or week. Default week."),
      },
      outputSchema: TRENDS_OUTPUT,
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({ ...(await metricsTrends({ range: args.range, bucket: args.bucket })) })),
  );

  server.registerTool(
    "cache",
    {
      title: "Prune the shared build caches",
      annotations: { readOnlyHint: false },
      description:
        "`werkmeister cache prune`: apply each registry cache's rule (max_age, prune command), " +
        "or empty it with `reset`. Dry run unless `dryRun: false`.",
      inputSchema: {
        name: z.string().optional().describe("One cache; default every cache in the registry."),
        reset: z.boolean().optional().describe("Empty the cache instead of applying its rule."),
        force: z.boolean().optional().describe("Prune even when a workspace using it is up."),
        dryRun: DRY_RUN,
      },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({
        results: await pruneCaches({
          name: args.name,
          reset: args.reset ?? false,
          force: args.force ?? false,
          dryRun: args.dryRun ?? true,
        }),
      })),
  );

  server.registerTool(
    "registry",
    {
      title: "Regenerate the service registry",
      annotations: { readOnlyHint: false },
      description:
        "`werkmeister registry sync`: rebuild ~/.werkmeister/services.yaml from every repo's " +
        ".werkmeister/services.yaml. With `check`, only report drift.",
      inputSchema: { check: z.boolean().optional().describe("Report drift only. Default false.") },
    },
    async (args): Promise<CallToolResult> =>
      adapt(async () => ({ steps: syncRegistry({ checkOnly: args.check ?? false }) })),
  );

  server.registerTool(
    "resources",
    {
      title: "CPU and memory per workspace",
      annotations: { readOnlyHint: true },
      description:
        "Container CPU and memory summed per Compose project, plus the host's load: what the " +
        "VS Code extension polls every 30 s.",
      inputSchema: {},
      outputSchema: z.looseObject({
        projects: z.record(
          z.string(),
          z.looseObject({ cpuPercent: z.number(), memMib: z.number() }),
        ),
        host: z.looseObject({
          load: z.tuple([z.number(), z.number(), z.number()]),
          cores: z.number(),
          featureCpuPercent: z.number(),
        }),
      }),
    },
    async (): Promise<CallToolResult> =>
      adapt(async () => ({ ...(await getWorkspaceResources()) })),
  );

  server.registerTool(
    "budget",
    {
      title: "Scheduler budget, running and waiting",
      annotations: { readOnlyHint: true },
      description:
        "`werkmeister budget status --json`: the scheduler's budget, slot leases, what each running " +
        "feature holds and what each waiter needs, in admission order: what the workspaces views poll.",
      inputSchema: {},
      outputSchema: z.looseObject({
        budget: z.looseObject({}),
        running: z.array(z.looseObject({})).nullable(),
        waiters: z.array(z.looseObject({})),
      }),
    },
    async (): Promise<CallToolResult> => adapt(async () => ({ ...(await budgetStatus()).json })),
  );

  server.registerTool(
    "intercepts",
    {
      title: "Telepresence intercept state",
      annotations: { readOnlyHint: true },
      description:
        "The telepresence connection and every feature's intercepts, without `status detail`'s " +
        "k8s forward probes: what the VS Code extension polls every 5 s.",
      inputSchema: {},
      outputSchema: z.looseObject({
        available: z.boolean(),
        installed: z.boolean(),
        connected_namespace: z.string().nullable(),
        intercepts: z.array(
          z.looseObject({
            feature: z.string(),
            service: z.string(),
            deployment: z.string().nullable(),
            interceptable: z.boolean(),
            blocker: z.string().nullable(),
            intercepted: z.boolean(),
            intercepted_by: z.string().nullable(),
          }),
        ),
        remote_services: z.array(z.string()),
      }),
    },
    async (): Promise<CallToolResult> => adapt(async () => ({ ...(await interceptsSnapshot()) })),
  );
}

/**
 * The scheduler's ops for thin clients (SW-185), run here because this process
 * owns the scheduler. Only `/api/tool` registers it: an agent has no use for it.
 */
export function registerSchedulerTool(server: McpServer): void {
  server.registerTool(
    "scheduler",
    {
      title: "Slot leases and the waiting queue",
      annotations: { readOnlyHint: false },
      description:
        "Internal: the CLI's scheduler calls (scheduler_client.ts), answered by the daemon.",
      inputSchema: {
        op: z.enum(["allocate", "lease", "release", "admit", "grant", "grant-later", "queue"]),
        feature: z.string().optional(),
        workspace: z.string().nullable().optional(),
        preferredSlot: z.number().int().nullable().optional(),
        byPerson: z.boolean().optional(),
        // Every field of `Starting`: zod strips a key the schema doesn't name, and a stripped `gate` queues a released gate as a plain waiter.
        starting: z
          .object({ services: z.array(z.string()), gate: z.literal(true).optional() })
          .optional(),
        fromQueue: z.boolean().optional(),
      },
    },
    async (a): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = a.feature ?? "";
        const ops: Record<typeof a.op, () => Promise<unknown> | unknown> = {
          allocate: () => allocateSlot(feature, a.preferredSlot, a.workspace),
          lease: () => slotLease(feature),
          release: () => releaseSlot(feature),
          admit: () =>
            admitOrQueue(feature, a.workspace ?? "", a.byPerson ?? false, a.starting, a.fromQueue),
          grant: () => grantWaiters(),
          "grant-later": () => grantInBackground(),
          queue: () => waitingQueue(),
        };
        return { value: (await timedOp(`${a.op} ${feature}`.trim(), ops[a.op])) ?? null };
      }),
  );
}

/** Past this a scheduler op is logged: its client gives up at 120 s, and the log held no op lines to say why (SW-1235). */
export const SLOW_OP_MS = 30_000;

/**
 * Runs *run*, logging when it started and what it was once it passes {@link SLOW_OP_MS}, and again when it ends.
 * The first line fires while it still runs: an op stuck on a lock or a hung call never reaches the end (SW-1235).
 */
export async function timedOp<T>(
  what: string,
  run: () => Promise<T> | T,
  log: (msg: string) => void = (m) => console.error(`[werkmeister-mcp] ${m}`),
  now: () => number = Date.now,
): Promise<T> {
  const start = now();
  const at = new Date(start).toISOString();
  const stuck = setTimeout(
    () => log(`${at} scheduler ${what} still running after ${SLOW_OP_MS / 1000} s`),
    SLOW_OP_MS,
  );
  stuck.unref();
  try {
    return await run();
  } finally {
    clearTimeout(stuck);
    const ms = now() - start;
    if (ms > SLOW_OP_MS) log(`${at} scheduler ${what} took ${Math.round(ms / 1000)} s`);
  }
}
