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
  /** Mid-gate or paused: stopping it would break a run in flight. */
  busy: boolean;
}

export interface Request {
  feature: string;
  cost: Cost;
  byPerson: boolean;
  /** Set for a start of these services (SW-540): *cost* is what they add to a running feature. */
  services?: string[];
}

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

/**
 * Whether *req* may start now. *running* is ordered longest-inactive first;
 * *queue* is the waiting features, first come first served.
 */
export function admit(budget: Budget, running: Lease[], queue: string[], req: Request): Decision {
  if (!req.services && running.some((l) => l.feature === req.feature)) return { kind: "admit" };
  if (req.cost.memory > budget.memory || req.cost.cpus > budget.cpus) {
    return { kind: "never-fits", cost: req.cost };
  }

  const used = running.reduce(
    (a, l) => ({ memory: a.memory + l.cost.memory, cpus: a.cpus + l.cost.cpus }),
    { memory: 0, cpus: 0 },
  );
  const fits = (freed: Cost) =>
    used.memory - freed.memory + req.cost.memory <= budget.memory &&
    used.cpus - freed.cpus + req.cost.cpus <= budget.cpus;

  const ahead = queue.indexOf(req.feature);
  const nobodyAhead = ahead === -1 ? queue.length === 0 : ahead === 0;
  if (fits({ memory: 0, cpus: 0 }) && (req.byPerson || nobodyAhead)) return { kind: "admit" };

  // An idle or human-check lease (a session parked on a question) has nobody in it, so a service start
  // that doesn't fit takes it (SW-546); only a person's start takes a working one. A plain `up` not by a
  // person (a grant's re-up of a victim) keeps waiting, or two preempted features would evict each other.
  if (budget.preempt && (req.byPerson || (req.services && nobodyAhead))) {
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

  return { kind: "wait", position: ahead === -1 ? queue.length + 1 : ahead + 1 };
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
