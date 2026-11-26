import type { EngineInterface } from "claude-code";

const BLOCKED = { plugin: "werkmeister", key: "stopBlocked" } as const;

/**
 * SW-1157: a turn that stops at a human check must not end while a stage output still reads
 * `status: proposed`. sw-404's and sw-783's question calls were interrupted as the session ended,
 * and the gate went unasked. SW-1185: it blocks while any proposed item is left, not only until one
 * question is answered (one answered batch of 4 let 3 more through). With `stop_hook_active` (the
 * agent was already told) it blocks again only while the count keeps falling: a stop with as many
 * left as at the last block is a gate the person deferred, and goes through.
 * Esc on an AskUserQuestion is not covered: Claude Code's docs say Stop does not run on a user
 * interrupt (not checked in a real session, SW-1185), so the contracts' ask-again line covers it.
 */
export async function stopGuard(
  $: EngineInterface,
  e: { stop_hook_active: boolean },
  root: string | null,
): Promise<string | null> {
  if (!root) return null;
  const hits: [string, number][] = [];
  const stages = await $.fs.list(`${root}/stages`).catch(() => []);
  for (const stage of stages
    .filter((s) => s.kind === "dir")
    .map((s) => s.name)
    .sort()) {
    const out = `stages/${stage}/output`;
    const files = await $.fs.list(`${root}/${out}`).catch(() => []);
    for (const f of files.filter((f) => f.kind === "file" && f.name.endsWith(".md"))) {
      const text = await $.fs.read(`${root}/${out}/${f.name}`).catch(() => "");
      const n = text.match(/^status:\s*proposed\b/gm)?.length ?? 0;
      if (n) hits.push([`${out}/${f.name}`, n]);
    }
  }
  const n = hits.reduce((sum, [, k]) => sum + k, 0);
  // No progress since the last block (or another hook's block): the person deferred, let it end.
  if (!n || (e.stop_hook_active && n >= ((await $.state.get(BLOCKED)).value ?? 0))) {
    await $.state.set(BLOCKED, 0);
    return null;
  }
  await $.state.set(BLOCKED, n);
  const where = `${n} proposed item${n === 1 ? "" : "s"} in ${hits.map(([f]) => f).join(", ")}: `;
  // An autonomous run's self-check flips its own outputs; only a stop point's question goes to the person.
  const yml = await $.fs.read(`${root}/.werkmeister/workspace.yml`).catch(() => "");
  return /^autonomous:\s*true\b/m.test(yml)
    ? `${where}flip the ones your self-check settles to decided, and ask only what a person must answer with AskUserQuestion.`
    : `${where}walk them with AskUserQuestion (batches of 4, recommended first), then flip each to decided with the approved-in-chat note.`;
}
