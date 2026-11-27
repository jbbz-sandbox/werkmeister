// SW-623: draws the /workspaces pane for the docs demo workspaces with no Claude session and no daemon.
//   node plugins/werkmeister/scripts/render-pane.mjs <out.ans | out.txt | out.png>
// `claude plugin test` mounts the pane against hooks/demo-fixture.ts and prints its element tree; this
// lays that tree out on a character grid the way the terminal does, then writes ANSI text or a PNG.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const COLUMNS = 72; // hooks/pane-render.ts mounts the pane at the same width

// Claude Code's dark theme.
const COLOR = {
  success: "#4eba65",
  warning: "#ffc107",
  error: "#ff6b80",
  inactive: "#999999",
  merged: "#af87ff",
  suggestion: "#b1b9f9",
};
const FG = "#ffffff";
const BG = "#1e1e1e";
const BORDER = { round: "╭╮╰╯─│", bold: "┏┓┗┛━┃" };

// shortcut: East Asian Wide ranges and the wide symbols below U+3000, not full string-width; add a range when a glyph misaligns.
const WIDE = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x10ffff],
];
export function cellWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfe0f || c === 0x200d) continue;
    w += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1;
  }
  return w;
}

const lineWidth = (line) => line.reduce((n, seg) => n + cellWidth(seg.t), 0);
const blank = (n) => (n > 0 ? [{ t: " ".repeat(n), s: null }] : []);
const pad = (line, w) => [...line, ...blank(w - lineWidth(line))];

function clip(line, w) {
  const out = [];
  let left = w;
  for (const seg of line) {
    if (left <= 0) break;
    let t = "";
    for (const ch of seg.t) {
      const cw = cellWidth(ch);
      if (cw > left) break;
      t += ch;
      left -= cw;
    }
    out.push({ ...seg, t });
  }
  return out;
}

const styleOf = (p, base) => {
  const s = { ...base };
  if (p?.color) s.color = p.color;
  if (p?.bold !== undefined) s.bold = p.bold;
  if (p?.dimColor !== undefined) s.dim = p.dimColor;
  return s;
};

function inline(node, base, out) {
  if (typeof node === "string") return out.push({ t: node, s: base });
  if (node.type === "Link")
    return out.push({ t: node.props.label ?? "", s: { ...base, underline: true } });
  for (const c of node.children ?? []) inline(c, styleOf(node.props, base), out);
}

/** Greedy word wrap of styled segments to `width` cells. */
function wrap(segs, width) {
  const lines = [[]];
  let x = 0;
  for (const seg of segs) {
    for (const tok of seg.t.split(/(\s+)/)) {
      if (!tok) continue;
      const w = cellWidth(tok);
      const space = /^\s+$/.test(tok);
      if (x + w > width && x > 0) {
        lines.push([]);
        x = 0;
        if (space) continue;
      }
      const line = lines.at(-1);
      if (line.at(-1)?.s === seg.s) line.at(-1).t += tok;
      else line.push({ t: tok, s: seg.s });
      x += w;
    }
  }
  return lines.map((l) => clip(l, width));
}

function button(p) {
  const s = { bold: !p.plain, dim: p.dimColor === true };
  if (p.variant === "primary") s.color = "suggestion";
  return [[{ t: p.plain ? p.label : `[ ${p.label} ]`, s }]];
}

function sized(kid, width) {
  const lines = layout(kid, width);
  return { lines, w: Math.max(0, kid.props?.minWidth ?? 0, ...lines.map(lineWidth)) };
}

function row(kids, p, inner) {
  const gap = p.gap ?? 0;
  const all = kids.map((k) => sized(k, inner));
  const bands = [[]];
  if (p.flexWrap === "wrap") {
    let x = 0;
    for (const k of all) {
      if (x > 0 && x + gap + k.w > inner) {
        bands.push([]);
        x = 0;
      }
      x += (x > 0 ? gap : 0) + k.w;
      bands.at(-1).push(k);
    }
  } else {
    // Ink's flexShrink, cut down: the widest child gives up the overflow and re-wraps.
    const over = all.reduce((n, k) => n + k.w, gap * (all.length - 1)) - inner;
    if (over > 0 && all.length > 1) {
      const i = all.reduce((m, k, j) => (k.w > all[m].w ? j : m), 0);
      all[i] = sized(kids[i], Math.max(1, all[i].w - over));
    }
    bands[0] = all;
  }
  return bands.flatMap((band) => {
    const gaps = band.map((_, i) => (i === 0 ? 0 : gap));
    if (p.justifyContent === "space-between" && band.length > 1) {
      const spare = inner - band.reduce((n, k, i) => n + k.w + gaps[i], 0);
      for (let i = 1; i < band.length; i++)
        gaps[i] += Math.floor(spare / (band.length - 1)) + (i <= spare % (band.length - 1) ? 1 : 0);
    }
    const h = Math.max(0, ...band.map((k) => k.lines.length));
    return Array.from({ length: h }, (_, y) =>
      band.flatMap((k, i) => [...blank(gaps[i]), ...pad(k.lines[y] ?? [], k.w)]),
    );
  });
}

/** Lines of styled segments for `node` in at most `width` cells. */
function layout(node, width) {
  if (typeof node === "string" || node.type === "Text") {
    const segs = [];
    inline(node, {}, segs);
    return wrap(segs, width);
  }
  const p = node.props ?? {};
  if (node.type === "Button") return button(p);
  if (node.type === "Link") return [[{ t: p.label ?? "", s: { underline: true } }]];
  const edge = p.borderStyle ? 1 : 0;
  const px = p.paddingX ?? 0;
  const inner = Math.max(1, width - 2 * edge - 2 * px);
  const kids = node.children ?? [];
  let lines =
    p.flexDirection === "column" ? kids.flatMap((k) => layout(k, inner)) : row(kids, p, inner);
  if (px || edge) lines = lines.map((l) => [...blank(px), ...pad(l, inner), ...blank(px)]);
  if (edge) {
    const [tl, tr, bl, br, h, v] = BORDER[p.borderStyle] ?? BORDER.round;
    const s = { color: p.borderColor, dim: p.borderDimColor === true };
    const span = h.repeat(width - 2);
    lines = [
      [{ t: tl + span + tr, s }],
      ...lines.map((l) => [{ t: v, s }, ...l, { t: v, s }]),
      [{ t: bl + span + br, s }],
    ];
  }
  return [...Array(p.marginTop ?? 0).fill([]), ...lines, ...Array(p.marginBottom ?? 0).fill([])];
}

/** The drawn tree as grid lines no wider than `columns`. */
export function paint(tree, columns = COLUMNS) {
  return layout(tree, columns).map((l) => clip(l, columns));
}

const hex = (c) => (c?.startsWith("#") ? c : COLOR[c]);
const rgb = (h) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)).join(";");

export function toAnsi(lines) {
  const sgr = ({ color, bold, dim, underline } = {}) =>
    [bold && "1", dim && "2", underline && "4", hex(color) && `38;2;${rgb(hex(color))}`]
      .filter(Boolean)
      .join(";");
  return lines
    .map((l) =>
      l
        .map(({ t, s }) => (s && sgr(s) ? `\x1b[${sgr(s)}m${t}\x1b[0m` : t))
        .join("")
        .trimEnd(),
    )
    .join("\n")
    .concat("\n");
}

export const LINE_PX = 16;
export const PAD_PX = 12;

export function toHtml(lines) {
  // A glyph from a fallback font is not exactly 1ch (or 2ch) wide, which bends the card's right border.
  const cell = (ch) =>
    ch.codePointAt(0) < 0x80 || /[─-╿]/.test(ch)
      ? ch
      : `<span style="display:inline-block;width:${cellWidth(ch)}ch;text-align:center">${ch}</span>`;
  const esc = (t) =>
    [...t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")].map(cell).join("");
  const css = ({ color, bold, dim, underline } = {}) =>
    [
      hex(color) && `color:${hex(color)}`,
      bold && "font-weight:bold",
      dim && "opacity:.7",
      underline && "text-decoration:underline",
    ]
      .filter(Boolean)
      .join(";");
  const body = lines
    .map((l) =>
      l
        .map(({ t, s }) => (s && css(s) ? `<span style="${css(s)}">${esc(t)}</span>` : esc(t)))
        .join(""),
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:${BG}}pre{margin:0;padding:${PAD_PX}px;color:${FG};font:14px/${LINE_PX}px Menlo,"DejaVu Sans Mono",monospace}</style><pre>${body}</pre>\n`;
}

/** Where Playwright keeps its browsers: its own override, then the real home's cache (SW-1016). */
export function browserCaches(env = process.env) {
  let home;
  try {
    // The user database's home, not $HOME: with-temp-home points $HOME at an empty temp dir.
    home = userInfo().homedir;
  } catch {
    home = homedir(); // a uid with no passwd entry (some containers)
  }
  return [
    env.PLAYWRIGHT_BROWSERS_PATH,
    join(home, "Library/Caches/ms-playwright"),
    join(home, ".cache/ms-playwright"),
  ].filter(Boolean);
}

export function chrome(env = process.env, caches = browserCaches(env)) {
  if (env.CHROME) return env.CHROME;
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const builds = readdirSync(cache)
      .filter((d) => d.startsWith("chromium_headless_shell-"))
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const b of builds)
      for (const d of readdirSync(join(cache, b))) {
        const bin = join(cache, b, d, "chrome-headless-shell");
        if (existsSync(bin)) return bin;
      }
  }
  return null;
}

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_FILES = [".claude-plugin/plugin.json", ".mcp.json", "types/index.d.ts"];

/** SW-1068: every hook module but the tests, so a new one register.tsx imports is copied without a list to update. */
export function hookFiles(plugin = PLUGIN) {
  return readdirSync(join(plugin, "hooks"))
    .filter((f) => !f.endsWith(".test.ts") && f !== "pane-render.ts")
    .map((f) => `hooks/${f}`);
}

/** The pane's drawn tree, from `claude plugin test` over a plugin copy whose only test is hooks/pane-render.ts. */
function drawnTree(tmp) {
  const plugin = PLUGIN;
  const copy = join(tmp, "plugin");
  for (const f of [...PLUGIN_FILES, ...hookFiles(), "hooks/pane-render.ts"]) {
    const to = join(copy, f === "hooks/pane-render.ts" ? "hooks/render.test.ts" : f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(plugin, f), to);
  }
  const run = spawnSync("claude", ["plugin", "test", copy], {
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  // The test runner sends console.log to stderr with its own report, so read both.
  const line = `${run.stdout}\n${run.stderr}`.split("\n").find((l) => l.startsWith("DRAWN>"));
  if (run.status !== 0 || !line)
    throw new Error(
      `claude plugin test drew no pane (exit ${run.status ?? run.error?.message}):\n${run.stdout}${run.stderr}`,
    );
  return JSON.parse(line.slice("DRAWN>".length));
}

function main([out]) {
  const ext = out ? extname(out) : "";
  if (![".ans", ".txt", ".png"].includes(ext)) {
    console.error(
      "usage: node plugins/werkmeister/scripts/render-pane.mjs <out.ans | out.txt | out.png>",
    );
    return 2;
  }
  const bin = ext === ".png" ? chrome() : null;
  if (ext === ".png" && !bin) {
    console.error(
      "PNG needs Chrome: set CHROME or install Playwright's chrome-headless-shell; .ans works without it",
    );
    return 1;
  }
  const tmp = mkdtempSync(join(tmpdir(), "w9r-pane-"));
  try {
    const lines = paint(drawnTree(tmp));
    if (ext !== ".png") {
      writeFileSync(out, toAnsi(lines));
      return 0;
    }
    const page = join(tmp, "pane.html");
    writeFileSync(page, toHtml(lines));
    const h = lines.length * LINE_PX + 2 * PAD_PX;
    const shot = spawnSync(
      bin,
      [
        "--headless",
        "--hide-scrollbars",
        `--user-data-dir=${join(tmp, "chrome")}`,
        `--screenshot=${out}`,
        `--window-size=640,${h}`,
        "--force-device-scale-factor=2",
        pathToFileURL(page).href,
      ],
      { encoding: "utf8" },
    );
    if (shot.status !== 0 || !existsSync(out))
      throw new Error(`Chrome wrote no PNG (exit ${shot.status}):\n${shot.stderr}`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  process.exitCode = main(process.argv.slice(2));
