import type { ClientModule } from "claude-code";

/**
 * The Create tab's text field, drawn by the plugin: the app's own Input carries
 * an Enter hint chip a plugin cannot remove, and has no multi-line mode.
 * Click to type; arrows, Home/End and Backspace/Delete edit; with `multiline`
 * Enter adds a line, without it Enter submits. Posts to the hooks module:
 * `{ focus: true }` on a click, `{ value }` on every edit, `{ submit: true }`
 * on a one-line Enter. A new `value` prop (an issue fetch filled it) replaces
 * the text; `focused` (the pane's last-clicked field) draws the cursor.
 * Pasting does not reach it: the engine hands a plugin's region keys, not pastes.
 */
type Props = { value: string; placeholder: string; multiline: boolean; focused: boolean };
type State = { text: string; cursor: number; seen: string };

/** [line, column] of `cursor` in `text`. */
function lineCol(text: string, cursor: number): [number, number] {
  const before = text.slice(0, cursor).split("\n");
  return [before.length - 1, (before.at(-1) ?? "").length];
}

/** The cursor index at `col` (clamped) on `line`. */
function indexAt(text: string, line: number, col: number): number {
  const lines = text.split("\n");
  let i = 0;
  for (let l = 0; l < line; l++) i += (lines[l] ?? "").length + 1;
  return i + Math.min(col, (lines[line] ?? "").length);
}

/** One key applied to the text and cursor; the same object back when the key changes nothing. */
export function edit(
  s: { text: string; cursor: number },
  key: string,
  ctrl?: boolean,
): { text: string; cursor: number } {
  const { text, cursor } = s;
  const [line, col] = lineCol(text, cursor);
  const last = text.split("\n").length - 1;
  switch (key) {
    case "return":
      return { text: text.slice(0, cursor) + "\n" + text.slice(cursor), cursor: cursor + 1 };
    case "backspace":
      return cursor === 0
        ? s
        : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 };
    case "delete":
      return cursor === text.length
        ? s
        : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor };
    case "left":
      return { text, cursor: Math.max(0, cursor - 1) };
    case "right":
      return { text, cursor: Math.min(text.length, cursor + 1) };
    case "up":
      return { text, cursor: line === 0 ? 0 : indexAt(text, line - 1, col) };
    case "down":
      return { text, cursor: line === last ? text.length : indexAt(text, line + 1, col) };
    case "home":
      return { text, cursor: cursor - col };
    case "end":
      return { text, cursor: indexAt(text, line, Infinity) };
  }
  // Space can arrive by name, which the next line would drop as a named key.
  if (key === "space") key = " ";
  // Any other named key (tab, pageup, f1, ...) or a ctrl chord types nothing.
  if (ctrl || key === "" || (key.length > 1 && /^[a-z0-9]+$/.test(key))) return s;
  return { text: text.slice(0, cursor) + key + text.slice(cursor), cursor: cursor + key.length };
}

const TextField: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements;
  let s = surface.state;
  if (!s || props.value !== s.seen) {
    // First draw, or the value changed from outside (a fetch): take it.
    s = { text: props.value, cursor: props.value.length, seen: props.value };
    surface.setState(s);
  }
  // Listeners are set on every draw (a later call replaces the last), so they see this draw's props.
  surface.onPointer((ev) => {
    if (ev.type === "down") surface.post({ focus: true });
  });
  surface.onKey((ev) => {
    const cur = surface.state;
    if (!cur) return;
    if (ev.key === "return" && !props.multiline) {
      surface.post({ submit: true });
      return;
    }
    const next = edit(cur, ev.key, ev.ctrl);
    if (next === cur) return;
    surface.setState({ ...next, seen: next.text });
    surface.post({ value: next.text });
  });
  const atEnd = s.text[s.cursor] === "\n" || s.cursor === s.text.length;
  return (
    <Box
      borderStyle="round"
      borderColor={props.focused ? "claude" : "inactive"}
      paddingX={1}
      flexDirection="column"
    >
      {s.text === "" && !props.focused ? (
        <Text dimColor>
          {props.placeholder ||
            (props.multiline ? "Click to type. Enter adds a line." : "Click to type.")}
        </Text>
      ) : !props.focused ? (
        <Text>{s.text}</Text>
      ) : (
        <Text>
          {s.text.slice(0, s.cursor)}
          <Text inverse>{atEnd ? " " : s.text[s.cursor]}</Text>
          {s.text.slice(atEnd ? s.cursor : s.cursor + 1)}
        </Text>
      )}
    </Box>
  );
};

export default TextField;
