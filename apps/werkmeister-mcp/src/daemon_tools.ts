/**
 * The CLI verbs that had no tool (clean, stats, optimize, cache, registry) and
 * the two reads the VS Code extension polls (resources, intercepts), so a thin
 * client never needs Docker or telepresence in its own process (SW-184).
 * Same adapter as tools.ts: the CLI's transcript as `content`, the core result
 * as `structuredContent`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { pruneCaches } from "werkmeister-core/build_caches";
import { containerStats } from "werkmeister-core/docker";
import {
  admitOrQueue,
  grantInBackground,
  grantWaiters,
  planClean,
  runClean,
} from "werkmeister-core/lifecycle";
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
      },
    },
    async (a): Promise<CallToolResult> =>
      adapt(async () => {
        const feature = a.feature ?? "";
        const ops: Record<typeof a.op, () => Promise<unknown> | unknown> = {
          allocate: () => allocateSlot(feature, a.preferredSlot, a.workspace),
          lease: () => slotLease(feature),
          release: () => releaseSlot(feature),
          admit: () => admitOrQueue(feature, a.workspace ?? "", a.byPerson ?? false),
          grant: () => grantWaiters(),
          "grant-later": () => grantInBackground(),
          queue: () => waitingQueue(),
        };
        return { value: (await ops[a.op]()) ?? null };
      }),
  );
}
