// Sample data shared by every board. Words follow the brief's vocabulary exactly.
export const TONE = {
  ok:   { fg: 'var(--sd-ok)',   bg: 'var(--sd-ok-bg)',   bd: 'var(--sd-ok-bd)' },
  warn: { fg: 'var(--sd-warn)', bg: 'var(--sd-warn-bg)', bd: 'var(--sd-warn-bd)' },
  err:  { fg: 'var(--sd-err)',  bg: 'var(--sd-err-bg)',  bd: 'var(--sd-err-bd)' },
  off:  { fg: 'var(--sd-off)',  bg: 'var(--sd-off-bg)',  bd: 'var(--sd-off-bd)' },
  pr:   { fg: 'var(--sd-pr)',   bg: 'var(--sd-pr-bg)',   bd: 'var(--sd-pr-bd)' },
  needs:{ fg: 'var(--sd-on-warn-solid)', bg: 'var(--sd-warn-solid)', bd: 'var(--sd-warn-solid)' },
};
export const AGENT = {
  needs:   { label: '● Needs you', tone: 'needs', pane: 'warn', codicon: 'circle-filled', vs: 'var(--vs-yellow)' },
  working: { label: '◌ Working',  tone: 'ok',    pane: 'ok',   codicon: 'sync', vs: 'var(--vs-green)' },
  done:    { label: '✓ Done',     tone: 'ok',    pane: 'ok',   codicon: 'pass', vs: 'var(--vs-green)' },
  idle:    { label: 'Idle',       tone: 'off',   pane: 'off',  codicon: 'circle-outline', vs: 'var(--vs-disabled)' },
};
export const SVC = {
  up:        { g: '●', tone: 'ok',   word: '' ,         codicon: 'circle-filled' },
  down:      { g: '○', tone: 'off',  word: '' ,         codicon: 'circle-outline' },
  unhealthy: { g: '▲', tone: 'err',  word: ' unhealthy', codicon: 'warning' },
  starting:  { g: '◐', tone: 'warn', word: ' starting',  codicon: 'loading' },
};
export const PRSTATE = { Open: 'ok', Draft: 'off', Merged: 'pr', Released: 'pr', Closed: 'off' };
export const CI = { pass: { t: 'CI ✓', tone: 'ok' }, fail: { t: 'CI ✗ N failing', tone: 'err' }, running: { t: 'CI running', tone: 'warn' } };

const ICM = (n, m, name) => ({ kind: 'icm', n, m, name, text: `ICM stage ${n} of ${m} · ${name}`, compact: `stage ${n}/${m} ${name}` });
const JIT = (p) => ({ kind: 'jit', text: `JIT · ${p}`, compact: `JIT · ${p}` });
const LIFE = (t) => ({ kind: 'life', text: t, compact: t });

export const OVERFLOW = ['↻ Refresh PRs', 'Open feature ↗', 'Open issue ↗', 'Logs'];
export const PANE_ONLY = ['⇆ Open beside', '📌 Pin'];

export const WS = {
  '143': {
    name: 'werkmeister-143-wizard-defaults', issue: 'jbbz-sandbox/werkmeister#143', type: 'Feature', title: 'Restore wizard defaults in the create form',
    containers: { summary: '0 of 2 up', tone: 'off', services: [['cli', 'down'], ['werkmeister-dashboard', 'down']] },
    prs: [], workflow: ICM(2, 4, 'findings'), agent: 'needs', auto: false, time: 'asked a question 12 min ago', where: 'Desktop',
    question: 'Work type is preselected as feature now. Should Workflow also remember the last choice (ICM or JIT), or always reset to ICM?',
    primary: '↗ Continue in Desktop', bar: ['▶ Up', '＋ New session'], extra: [],
  },
  '206': {
    name: 'werkmeister-206-pane-turn-state', issue: 'jbbz-sandbox/werkmeister#206', type: 'Bug', title: 'Turn state is lost between pane polls',
    containers: { summary: '2 of 2 up', tone: 'ok', services: [['cli', 'up'], ['werkmeister-dashboard', 'up']] },
    prs: [{ ref: 'werkmeister#231', state: 'Draft', ci: 'running' }], workflow: ICM(4, 5, 'implement'), agent: 'working', auto: true, time: 'last activity 40 s ago', where: 'Terminal',
    primary: '↗ Continue in Terminal', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  '151': {
    name: 'werkmeister-151-close-out-copy', issue: 'jbbz-sandbox/werkmeister#151', type: 'Task', title: 'Reword the close-out confirmation',
    containers: { summary: '1 of 2 up', tone: 'warn', services: [['cli', 'up'], ['werkmeister-dashboard', 'unhealthy']] },
    prs: [{ ref: 'werkmeister#186', state: 'Released v0.14.0', ci: 'pass' }], workflow: LIFE('Ready to close out'), agent: 'done', auto: false, time: 'idle since 2 days ago', where: 'Desktop',
    primary: '✓ Close out', bar: ['↻ Restart', '⏻ Down'], extra: ['↗ Continue in Desktop', '＋ New session'],
  },
  'bwell': {
    name: 'bwell', issue: null, type: 'Spike', title: 'BWell technologies',
    containers: { summary: 'down', tone: 'off', services: [] },
    prs: [{ ref: 'wellness#12', state: 'Open', ci: 'fail', failing: 2 }], workflow: JIT('implement'), agent: 'idle', auto: false, time: 'no live turn, nothing asked', where: 'Desktop',
    primary: '▶ Up', bar: ['↗ Continue in Desktop', '＋ New session'], extra: [],
  },
  'loading': { name: 'werkmeister-220-starting', loading: true },
  // edge cases
  'long': {
    name: 'werkmeister-312-backfill-autonomous-flag-for-every-legacy-workspace-yml', issue: 'jbbz-sandbox/werkmeister#312', type: 'Refactor', title: 'Backfill the autonomous flag in legacy workspace files',
    containers: { summary: '1 of 1 up', tone: 'ok', services: [['cli', 'up']] },
    prs: [], workflow: ICM(1, 4, 'questions'), agent: 'working', auto: false, time: 'last activity 3 min ago', where: 'Terminal',
    primary: '↗ Continue in Terminal', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  'twoprs': {
    name: 'werkmeister-198-split-cli-package', issue: 'jbbz-sandbox/werkmeister#198', type: 'Refactor', title: 'Split the CLI into core and commands',
    containers: { summary: '2 of 2 up', tone: 'ok', services: [['cli', 'up'], ['werkmeister-core', 'up']] },
    prs: [{ ref: 'werkmeister#228', state: 'Merged', ci: 'pass' }, { ref: 'werkmeister#233', state: 'Open', ci: 'running' }], workflow: LIFE('Awaiting release'), agent: 'done', auto: true, time: 'idle since 5 h ago', where: 'Terminal',
    primary: '↗ Continue in Terminal', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  'many': {
    name: 'demo-checkout-latency', issue: 'jbbz-sandbox/demo-services#88', type: 'Incident', title: 'Checkout p95 latency above 2 s',
    containers: { summary: '6 of 7 up', tone: 'warn', services: [['backend', 'up'], ['clickhouse', 'up'], ['frontend', 'up'], ['mongo', 'up'], ['redpanda', 'starting'], ['api', 'up'], ['werkmeister-core', 'up']] },
    prs: [], workflow: JIT('investigate'), agent: 'working', auto: false, time: 'last activity 1 min ago', where: 'Desktop',
    primary: '↗ Continue in Desktop', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  'noissue': {
    name: 'scratch-telemetry', issue: null, type: 'Spike', title: 'Try OpenTelemetry in the CLI',
    containers: { summary: '1 of 1 up', tone: 'ok', services: [['cli', 'up']] },
    prs: [], workflow: JIT('explore'), agent: 'idle', auto: false, time: 'no live turn, nothing asked', where: 'Desktop',
    primary: '↗ Continue in Desktop', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  'prerr': {
    name: 'werkmeister-209-pr-poll-backoff', issue: 'jbbz-sandbox/werkmeister#209', type: 'Bug', title: 'PR polling hammers the API after sleep',
    containers: { summary: '2 of 2 up', tone: 'ok', services: [['cli', 'up'], ['werkmeister-dashboard', 'up']] },
    prs: [], prError: true, workflow: ICM(3, 4, 'implement'), agent: 'needs', auto: false, time: 'asked a question 3 min ago', where: 'Terminal',
    question: 'Back off to 5 min after a 403, or stop polling until the next manual ↻ Refresh PRs?',
    primary: '↗ Continue in Terminal', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
  'dockerdown': {
    name: 'werkmeister-215-compose-profiles', issue: 'jbbz-sandbox/werkmeister#215', type: 'Feature', title: 'Compose profiles per service group',
    containers: { summary: 'Containers unknown', tone: 'off', unknown: true, services: [] },
    prs: [{ ref: 'werkmeister#236', state: 'Open', ci: 'pass' }], workflow: ICM(4, 4, 'ship'), agent: 'working', auto: true, time: 'last activity 2 min ago', where: 'Terminal',
    primary: '↗ Continue in Terminal', bar: ['■ Stop', '↻ Restart'], extra: ['⏻ Down', '＋ New session'],
  },
};

export function prTone(state) { return PRSTATE[state.split(' ')[0]] || 'off'; }
export function ciText(p) { return p.ci === 'fail' ? `CI ✗ ${p.failing} failing` : CI[p.ci].t; }

// Display model consumed by the card / pane / tree DCs.
export function model(id) {
  const w = WS[id];
  if (!w) return null;
  if (w.loading) return { id, name: w.name, loading: true };
  const svc = w.containers.services.map(([n, s]) => ({ name: n, st: s, text: `${SVC[s].g} ${n}${SVC[s].word}`, ...TONE[SVC[s].tone], codicon: SVC[s].codicon, desc: s === 'up' ? 'healthy' : s }));
  const prs = w.prs.map(p => ({ ref: p.ref, state: p.state, stateT: TONE[prTone(p.state)], draft: p.state === 'Draft', ci: ciText(p), ciT: TONE[p.ci === 'fail' ? 'err' : CI[p.ci].tone] }));
  const a = AGENT[w.agent];
  const compact = [
    { k: 'containers', parts: [{ t: w.containers.summary, ...TONE[w.containers.tone] }] },
    { k: 'PRs', parts: w.prError ? [{ t: 'PRs unavailable', ...TONE.warn }] : prs.length ? prs.flatMap(p => [{ t: p.ref, fg: 'var(--sd-info)' }, { t: p.state, ...p.stateT }, { t: p.ci, ...p.ciT }]) : [{ t: 'none yet', ...TONE.off }] },
    { k: '', parts: [{ t: w.workflow.compact, fg: 'var(--sd-ink)' }] },
  ];
  const stages = w.workflow.kind === 'icm' ? Array.from({ length: w.workflow.m }, (_, i) => ({ c: i < w.workflow.n - 1 ? 'var(--sd-ink)' : i === w.workflow.n - 1 ? 'var(--sd-muted)' : 'var(--sd-line)' })) : [];
  const shortCount = w.containers.unknown ? 'Containers unknown' : w.containers.summary;
  return {
    id, ...w, svc, prs, stages, compact,
    subtitle: `${w.type} · ${w.title}`,
    agentLabel: a.label, agentT: TONE[a.tone], agentPane: TONE[a.pane], codicon: a.codicon, vsColor: a.vs,
    needs: w.agent === 'needs',
    autoFull: '⚙ Autonomous', autoCompact: '⚙ Auto',
    summaryT: TONE[w.containers.tone],
    vsDesc: `${a.label} · ${shortCount} · ${w.workflow.kind === 'icm' ? `stage ${w.workflow.n}/${w.workflow.m}` : w.workflow.compact}`,
    primaryDestructive: w.primary === '✓ Close out',
    menu: [...w.extra, ...OVERFLOW],
  };
}
export const SAMPLE = ['143', '206', '151', 'bwell', 'loading'];
export const EDGE = ['long', 'twoprs', 'many', 'noissue', 'prerr', 'dockerdown'];
