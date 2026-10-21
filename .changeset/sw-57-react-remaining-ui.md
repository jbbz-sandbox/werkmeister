---
"werkmeister-ui": minor
"werkmeister-mcp": patch
---

SW-57: the rest of the UI is React. The chat panel, the options input, the usage breakdown, the create form's card and the dashboard's tab shell, Open Pull Requests, Health and Links tabs no longer use the vanilla-DOM `el()` / `injectCss()` helpers, which are gone. Each component renders its own stylesheet with `Css` (a React-hoisted `<style>`, one per component); the tokens stay CSS custom properties in `tokens.css`. `werkmeister-ui` now exports `ChatPanel`, `OptionsInput`, `Usage`, `CreateForm` and `WorkspaceList` in place of `initChatPanel`, `createOptionsInput` and `renderUsage`; `initWorkspaceUI` and `initCreateForm` keep their signatures. The workspace card takes `renderPanel(kind)` instead of `mountPanel(kind, host)`. On the Desktop-inline and Cowork surfaces an open chat now syncs the transcript every 3 s while a turn runs, as its polling was meant to, instead of only when the turn ends.
