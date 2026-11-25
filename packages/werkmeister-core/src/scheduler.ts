/**
 * Admission and slot choice for the file-backed scheduler (SW-181). Pure: the
 * state comes in as arguments, so it is testable without Docker or a lock.
 * `scheduler_state.ts` holds the files; `lifecycle.ts` gathers the running set
 * from Docker and acts on the decision.
 */

/** Bytes and cores. */
export interface Cost {
  memory: number;
  cpus: number;
}

export interface Budget extends Cost {
  /** A start that doesn't fit may stop features nobody is in; a person's may also stop working ones. */
  preempt: boolean;
}

/** Victim order, lowest first. A "person" feature is never preempted. */
export type Rank = "idle" | "human-check" | "working" | "person";

export interface Lease {
  feature: string;
  cost: Cost;
  rank: Rank;
  /** A `docker exec` running in it, mid-gate or paused: stopping it would break a run in flight. */
  busy: boolean;
  /** Its running compose services, when Docker's labels name them (SW-907). */
  services?: string[];
}

export interface Request {
  feature: string;
  cost: Cost;
  byPerson: boolean;
  /** Set for a start of these services (SW-540): *cost* is what they add to a running feature. */
  services?: string[];
  /** A gate that released its own containers to wait for them and its new ones together (SW-675). */
  gate?: boolean;
  /** A whole `up` of a running feature: what its `up` services not yet running add (SW-907). */
  added?: Cost;
}

/** A queued request as admission sees it (SW-675). */
export interface Waiter {
  feature: string;
  /** Since its first wait; 0 when unknown. */
  waitedMs: number;
  /** A services start for a feature that already runs containers: a gate, or `up --service` beside them. */
  gate: boolean;
  /** A whole-feature waiter's cost; unset for a services start, whose own poll admits it. */
  cost?: Cost;
  /** A `--service` start that gave up polling and waits for a grant (SW-701): it never holds the room. */
  parked?: boolean;
}

/** How long the queue head waits before backfill stops passing it and a plain `up` head may preempt (SW-675). */
// Well inside the 10-min service wait, so a service start reaches it before it times out (SW-675 review).
export const STARVE_MS = 5 * 60_000;

export type Decision =
  | { kind: "admit" }
  | { kind: "preempt"; victims: string[] }
  | { kind: "wait"; position: number }
  /** *cost* alone exceeds the whole budget: no preemption or wait can ever make room (SW-629). */
  | { kind: "never-fits"; cost: Cost };

const UNITS: Record<string, number> = {
  "": 1,
  b: 1,
  k: 2 ** 10,
  m: 2 ** 20,
  g: 2 ** 30,
  t: 2 ** 40,
};

/** A compose size ("512M", "1.5g", "2GB") or a byte count, in bytes. */
export function parseSize(s: string | number): number {
  if (typeof s === "number") return s;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmgt]?)b?\s*$/i.exec(s);
  if (!m) throw new Error(`Not a size: '${s}'`);
  return Math.round(Number(m[1]) * (UNITS[m[2].toLowerCase()] ?? 1));
}

const RANK_ORDER: Rank[] = ["idle", "human-check", "working"];

/** Gate waiters first, then the rest, each first come first served: a gate frees its whole feature soonest (SW-675). */
export function queueOrder(queue: Waiter[]): Waiter[] {
  return [...queue.filter((w) => w.gate), ...queue.filter((w) => !w.gate)];
}

/**
 * Whether the starved *head* can wait its room out: it fits once every lease but a person's leaves.
 * A person's lease never ends by itself, so holding for one only stalls the queue (SW-903).
 * A head of unknown cost (a service start) is assumed to.
 */
export function headCanWaitOut(budget: Budget, running: Lease[], head: Waiter): boolean {
  if (!head.cost) return true;
  const kept = running
    .filter((l) => l.rank === "person" && l.feature !== head.feature)
    .reduce((a, l) => ({ memory: a.memory + l.cost.memory, cpus: a.cpus + l.cost.cpus }), {
      memory: 0,
      cpus: 0,
    });
  return (
    kept.memory + head.cost.memory <= budget.memory && kept.cpus + head.cost.cpus <= budget.cpus
  );
}

/**
 * The leases only a person can free, when waiting could free nothing else that makes room for *need*
 * (SW-1147); else []. Blocked: waiting on a person with a run in flight, which neither preemption nor the
 * idle reaper takes. *feature*'s own lease and *reserved* starts never free room during its wait.
 */
export function blockedOnPerson(
  budget: Budget,
  running: Lease[],
  feature: string,
  need: Cost,
  reserved: Lease[] = [],
): Lease[] {
  const blocked = running.filter(
    (l) => l.feature !== feature && l.rank === "human-check" && l.busy,
  );
  const kept = [...blocked, ...reserved, ...running.filter((l) => l.feature === feature)].reduce(
    (a, l) => ({ memory: a.memory + l.cost.memory, cpus: a.cpus + l.cost.cpus }),
    need,
  );
  return kept.memory > budget.memory || kept.cpus > budget.cpus ? blocked : [];
}

/**
 * Whether *req* may start now. *running* is ordered longest-inactive first;
 * *queue* is the waiting requests, first come first served.
 */
/** A whole `up` of *feature* adds only what its running lease doesn't already hold (SW-889). */
function added(cost: Cost, running: Lease[], feature: string): Cost {
  const own = running.find((l) => l.feature === feature);
  if (!own) return cost;
  return {
    memory: Math.max(0, cost.memory - own.cost.memory),
    cpus: Math.max(0, cost.cpus - own.cost.cpus),
  };
}

export function admit(budget: Budget, running: Lease[], queue: Waiter[], req: Request): Decision {
  const reup = !req.services && running.some((l) => l.feature === req.feature);
  const cost = req.services ? req.cost : (req.added ?? added(req.cost, running, req.feature));
  if (reup && !cost.memory && !cost.cpus) return { kind: "admit" };
  if (req.cost.memory > budget.memory || req.cost.cpus > budget.cpus) {
    return { kind: "never-fits", cost: req.cost };
  }

  const used = running.reduce(
    (a, l) => ({ memory: a.memory + l.cost.memory, cpus: a.cpus + l.cost.cpus }),
    { memory: 0, cpus: 0 },
  );
  const fits = (freed: Cost) =>
    used.memory - freed.memory + cost.memory <= budget.memory &&
    used.cpus - freed.cpus + cost.cpus <= budget.cpus;

  const gate = !!req.gate || (!!req.services && running.some((l) => l.feature === req.feature));
  const queued = queue.find((w) => w.feature === req.feature);
  const self = { feature: req.feature, waitedMs: queued?.waitedMs ?? 0, gate };
  const order = queueOrder(queued ? queue.map((w) => (w === queued ? self : w)) : [...queue, self]);
  const position = order.indexOf(self) + 1;
  const isHead = position === 1;
  // Backfill: what fits starts past a head that doesn't, unless the head is a gate (it frees its whole
  // feature soonest) or has waited STARVE_MS (SW-675). Never against a service start of a busy
  // feature: it is how its gate ends and frees the lease the head may be waiting on (SW-699).
  // shortcut: busy also covers a gate exec in the last idle_stop_minutes, so a recent gate's later
  // --service start passes too; tighten to a live-gate signal if heads starve again.
  const endsGate = !!req.services && running.some((l) => l.feature === req.feature && l.busy);
  // Only a release's grant starts a whole-feature head, and room can free without one (a timed-out
  // gate's stop, a Docker restart), so holding behind one that fits now waits forever (SW-729).
  // A parked head's cost is just its services; a whole-feature head's, its set less what already runs.
  const headCost =
    order[0].cost && !order[0].parked
      ? added(order[0].cost, running, order[0].feature)
      : order[0].cost;
  const headAwaitsGrant =
    !!headCost &&
    used.memory + headCost.memory <= budget.memory &&
    used.cpus + headCost.cpus <= budget.cpus;
  // A parked head never holds: it may wait without end, and a hold would then hold for good (SW-701).
  const headHolds =
    !isHead &&
    !endsGate &&
    !headAwaitsGrant &&
    !order[0].parked &&
    (order[0].gate ||
      (order[0].waitedMs >= STARVE_MS && headCanWaitOut(budget, running, order[0])));
  if (fits({ memory: 0, cpus: 0 }) && (req.byPerson || !headHolds)) return { kind: "admit" };

  // An idle or human-check lease (a session parked on a question) has nobody in it, so the queue head
  // takes it (SW-546); only a person's start takes a working one. A plain `up` head (a grant's re-up of
  // a victim among them) waits STARVE_MS first, or two preempted features would evict each other.
  const headMayPreempt = isHead && (!!req.services || self.waitedMs >= STARVE_MS);
  if (budget.preempt && (req.byPerson || headMayPreempt)) {
    const ranks = req.byPerson ? RANK_ORDER : RANK_ORDER.slice(0, 2);
    // Never its own lease (stopping what it runs to start one more service of it), nor one that
    // frees nothing (containers with no reservation or CPU limit): stopped for no gain.
    const candidates = ranks.flatMap((r) =>
      running.filter(
        (l) =>
          l.rank === r && !l.busy && l.feature !== req.feature && (l.cost.memory || l.cost.cpus),
      ),
    );
    const victims: string[] = [];
    const freed = { memory: 0, cpus: 0 };
    for (const l of candidates) {
      victims.push(l.feature);
      freed.memory += l.cost.memory;
      freed.cpus += l.cost.cpus;
      if (fits(freed)) return { kind: "preempt", victims };
    }
  }

  return { kind: "wait", position };
}

/**
 * The slot *feature* should hold. *held* maps slot → owning feature. Its own
 * slot first, then a free *preferred*, then the lowest free; null when full.
 */
export function pickSlot(
  feature: string,
  held: Map<number, string>,
  count: number,
  preferred: number | null,
): number | null {
  for (const [slot, owner] of held) if (owner === feature) return slot;
  if (preferred !== null && preferred >= 1 && preferred <= count && !held.has(preferred)) {
    return preferred;
  }
  for (let s = 1; s <= count; s++) if (!held.has(s)) return s;
  return null;
}
