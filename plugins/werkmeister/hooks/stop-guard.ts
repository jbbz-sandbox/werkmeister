import type { EngineInterface } from "claude-code";

/**
 * SW-1157: a turn that stops at a human check must not end while a stage output still reads
 * `status: proposed` and nothing was asked. sw-404's and sw-783's question calls were interrupted as
 * the session ended, and the gate went unasked. Blocks the stop once: with `stop_hook_active` (the
 * agent was already told) it lets the stop through, so a gate the person deferred can still end.
 */
export async function stopGuard(
  $: EngineInterface,
  e: { stop_hook_active: boolean; transcript_path: string },
  root: string | null,
): Promise<string | null> {
  if (e.stop_hook_active || !root) return null;
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
  if (!hits.length) return null;
  const transcript = e.transcript_path ? await $.fs.read(e.transcript_path).catch(() => "") : "";
  if (answeredThisTurn(transcript)) return null;
  const n = hits.reduce((sum, [, k]) => sum + k, 0);
  const where = `${n} proposed item${n === 1 ? "" : "s"} in ${hits.map(([f]) => f).join(", ")}: `;
  // An autonomous run's self-check flips its own outputs; only a stop point's question goes to the person.
  const yml = await $.fs.read(`${root}/.werkmeister/workspace.yml`).catch(() => "");
  return /^autonomous:\s*true\b/m.test(yml)
    ? `${where}flip the ones your self-check settles to decided, and ask only what a person must answer with AskUserQuestion.`
    : `${where}walk them with AskUserQuestion (batches of 4, recommended first), then flip each to decided with the approved-in-chat note.`;
}

type Block = {
  type?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  is_error?: boolean;
};
type Entry = { type?: string; message?: { content?: string | Block[] } };

/** Whether an AskUserQuestion call came back without an error since the person's last typed prompt. */
export function answeredThisTurn(jsonl: string): boolean {
  const entries: Entry[] = [];
  for (const line of jsonl.split("\n")) {
    try {
      if (line.trim()) entries.push(JSON.parse(line));
    } catch {
      // A torn last line while the session writes: skip it.
    }
  }
  const blocks = (x: Entry) => (Array.isArray(x.message?.content) ? x.message.content : []);
  const prompt = entries.findLastIndex(
    (x) => x.type === "user" && !blocks(x).some((b) => b.type === "tool_result"),
  );
  const asks = new Set<string>();
  for (const x of entries.slice(prompt + 1)) {
    for (const b of blocks(x)) {
      if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.id) asks.add(b.id);
      if (b.type === "tool_result" && b.tool_use_id && asks.has(b.tool_use_id) && !b.is_error)
        return true;
    }
  }
  return false;
}
