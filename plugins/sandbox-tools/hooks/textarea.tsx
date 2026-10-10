import type { ClientModule } from 'claude-code'

/**
 * A multi-line text field for the Create tab: the pane's own Input is one line.
 * Click to type; Enter adds a line; arrows, Home/End and Backspace/Delete edit.
 * Every edit is posted to the hooks module as `{ value }`; a new `value` prop
 * (an issue fetch filled it) replaces the text.
 */
type Props = { value: string; placeholder: string }
type State = { text: string; cursor: number; seen: string; focused: boolean }

/** [line, column] of `cursor` in `text`. */
function lineCol(text: string, cursor: number): [number, number] {
  const before = text.slice(0, cursor).split('\n')
  return [before.length - 1, before[before.length - 1]!.length]
}

/** The cursor index at `col` (clamped) on `line`. */
function indexAt(text: string, line: number, col: number): number {
  const lines = text.split('\n')
  let i = 0
  for (let l = 0; l < line; l++) i += lines[l]!.length + 1
  return i + Math.min(col, lines[line]!.length)
}

/** One key applied to the text and cursor; the same object back when the key changes nothing. */
export function edit(s: { text: string; cursor: number }, key: string, ctrl?: boolean): { text: string; cursor: number } {
  const { text, cursor } = s
  const [line, col] = lineCol(text, cursor)
  const last = text.split('\n').length - 1
  switch (key) {
    case 'return': return { text: text.slice(0, cursor) + '\n' + text.slice(cursor), cursor: cursor + 1 }
    case 'backspace': return cursor === 0 ? s : { text: text.slice(0, cursor - 1) + text.slice(cursor), cursor: cursor - 1 }
    case 'delete': return cursor === text.length ? s : { text: text.slice(0, cursor) + text.slice(cursor + 1), cursor }
    case 'left': return { text, cursor: Math.max(0, cursor - 1) }
    case 'right': return { text, cursor: Math.min(text.length, cursor + 1) }
    case 'up': return { text, cursor: line === 0 ? 0 : indexAt(text, line - 1, col) }
    case 'down': return { text, cursor: line === last ? text.length : indexAt(text, line + 1, col) }
    case 'home': return { text, cursor: cursor - col }
    case 'end': return { text, cursor: indexAt(text, line, Infinity) }
  }
  // Any other named key (tab, pageup, f1, ...) or a ctrl chord types nothing.
  if (ctrl || key === '' || (key.length > 1 && /^[a-z0-9]+$/.test(key))) return s
  // A typed character, or a paste delivered as one string.
  return { text: text.slice(0, cursor) + key + text.slice(cursor), cursor: cursor + key.length }
}

const Textarea: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const prev = surface.state
  let s = prev
  if (!s || props.value !== s.seen) {
    // First draw, or the value changed from outside (a fetch): take it.
    s = { text: props.value, cursor: props.value.length, seen: props.value, focused: prev?.focused ?? false }
    if (!prev) {
      surface.onPointer(ev => {
        const cur = surface.state
        if (ev.type === 'down' && cur && !cur.focused) surface.setState({ ...cur, focused: true })
      })
      surface.onKey(ev => {
        const cur = surface.state
        if (!cur) return
        const next = edit(cur, ev.key, ev.ctrl)
        if (next === cur) return
        surface.setState({ ...cur, ...next, seen: next.text, focused: true })
        surface.post({ value: next.text })
      })
    }
    surface.setState(s)
  }
  const atNewline = s.text[s.cursor] === '\n' || s.cursor === s.text.length
  return (
    <Box borderStyle="round" borderColor={s.focused ? 'claude' : 'inactive'} paddingX={1} flexDirection="column">
      {s.text === '' && !s.focused ? (
        <Text dimColor>{props.placeholder || 'Click to type. Enter adds a line.'}</Text>
      ) : !s.focused ? (
        <Text>{s.text}</Text>
      ) : (
        <Text>
          {s.text.slice(0, s.cursor)}
          <Text inverse>{atNewline ? ' ' : s.text[s.cursor]}</Text>
          {s.text.slice(atNewline ? s.cursor : s.cursor + 1)}
        </Text>
      )}
    </Box>
  )
}

export default Textarea
