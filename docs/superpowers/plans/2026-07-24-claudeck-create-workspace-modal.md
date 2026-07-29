# Claudeck Create-Workspace Modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Create Workspace" tab to Claudeck's Add Project modal that renders the `sandbox workspace` form, streams creation live, and drops the user into the new workspace.

**Architecture:** The `sandbox-driver` package gains an additive `onData` streaming callback on `createWorkspace`/`runSandbox`. The Claudeck **sandbox-workspace plugin** grows four driver-backed routes (`form-schema`, `jira-form-data`, `refine-prompt`, `create`) plus a vanilla schema-driven form renderer. The core Add Project modal is minimally edited into a two-tab modal; the create form is plugin code dynamically imported on first open. Post-create reuses the existing `addProject`/`loadProjects` path.

**Tech Stack:** Node.js/Express (plugin server, plain ESM JS), vanilla DOM (Claudeck frontend), TypeScript (`sandbox-driver`), `node --test` for unit tests.

## Global Constraints

- **No `innerHTML` of untrusted data.** All git/gh/docker/CLI/Jira output → DOM via `textContent`/`createElement`. (Scheme-check any URL before using as `href`: `^https?://`.)
- **Best-effort server routes:** a failing `gh`/`docker`/`sandbox`/driver call degrades to a null/empty/error state, never a thrown client error or unhandled 500.
- **Driver changes are additive & backward-compatible:** existing buffered callers must be byte-for-byte unaffected when `onData` is absent.
- **Minimize vendored-core edits:** touch only `public/js/components/add-project-modal.js` and `public/js/features/projects.js`; keep workspace logic in the plugin. Record every core edit in `apps/claudeck/VENDORED.md`.
- **Plugin server is plain ESM JS**; import the driver as `import { … } from "sandbox-driver"` (resolves to `packages/sandbox-driver/dist/sandbox.js`).
- **Streaming wire format** matches the existing `/action` route: chunked `text/plain`, terminating `[exit N]` line.
- Commit after every task. Run from repo root `/Users/jayboyer/workspace/sandbox` unless a step says otherwise.

---

## File Structure

**Driver (`packages/sandbox-driver/`):**
- `sandbox.ts` — MODIFY: add exported `spawnCapture`; thread `onData` through `runSandbox` + `createWorkspace`.
- `spawn-capture.test.mjs` — CREATE: `node --test` for `spawnCapture` against compiled `dist/`.
- `package.json` — MODIFY: add `test` script.

**Plugin (`apps/claudeck/plugins/sandbox-workspace/`):**
- `parse-form-schema.mjs` (+ `.test.mjs`) — CREATE: pure RJSF-bundle → field-descriptor mapper.
- `create-form.mjs` — CREATE: vanilla form renderer + Fetch-from-Jira + Refine + Create/stream.
- `server.js` — MODIFY: 4 new driver-backed routes.

**Claudeck core (vendored — minimal edits):**
- `apps/claudeck/package.json` — MODIFY: add `sandbox-driver` dependency.
- `public/js/components/add-project-modal.js` — MODIFY: tab bar + two panels + scoped `<style>`.
- `public/js/features/projects.js` — MODIFY: tab switch + lazy import + post-create glue.
- `VENDORED.md` — MODIFY: record the core edits + driver dep.

---

## Task 1: Driver — streaming `spawnCapture` + `onData` passthrough

**Files:**
- Modify: `packages/sandbox-driver/sandbox.ts` (add `spawnCapture`; edit `runSandbox` ~line 150-165 and `createWorkspace` ~line 1004-1023)
- Create: `packages/sandbox-driver/spawn-capture.test.mjs`
- Modify: `packages/sandbox-driver/package.json` (add `test` script)

**Interfaces:**
- Produces:
  - `spawnCapture(bin: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv; onData?: (chunk: string) => void }): Promise<{ stdout: string; stderr: string; code: number | null }>` — streams chunks to `onData`, accumulates, resolves with full output + exit code; rejects only on spawn error.
  - `runSandbox(args, cwd?, onData?)` — when `onData` given, runs via `spawnCapture` and throws `WorkspaceError` on non-zero exit; else unchanged buffered path.
  - `createWorkspace(formData, opts?: { open?: boolean; onData?: (chunk: string) => void })` — passes `onData` through; return type `CreateResult` unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox-driver/spawn-capture.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execPath } from "node:process";
import { spawnCapture } from "./dist/sandbox.js";

test("forwards stdout+stderr chunks and returns combined output + code", async () => {
  const chunks = [];
  const res = await spawnCapture(
    execPath,
    ["-e", "process.stdout.write('out');process.stderr.write('err')"],
    { onData: (c) => chunks.push(c) },
  );
  assert.equal(res.stdout, "out");
  assert.equal(res.stderr, "err");
  assert.equal(res.code, 0);
  assert.equal(chunks.join(""), "outerr"); // both streams reached onData
});

test("non-zero exit resolves (does not reject) with code", async () => {
  const res = await spawnCapture(execPath, ["-e", "process.exit(3)"]);
  assert.equal(res.code, 3);
});

test("works with no onData (pure capture)", async () => {
  const res = await spawnCapture(execPath, ["-e", "process.stdout.write('hi')"]);
  assert.equal(res.stdout, "hi");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd packages/sandbox-driver && npx tsc && node --test spawn-capture.test.mjs`
Expected: FAIL — `spawnCapture` is not exported from `./dist/sandbox.js` (`SyntaxError: … does not provide an export named 'spawnCapture'`).

- [ ] **Step 3: Add `spawnCapture` and thread `onData` through**

In `packages/sandbox-driver/sandbox.ts`, add `spawnCapture` immediately above `runSandbox` (both `spawn` and `childEnv` are already in scope):

```ts
/**
 * Spawn `bin args`, streaming each stdout/stderr chunk to `onData` (if given)
 * while accumulating them. Resolves with the full output and exit code; never
 * rejects on a non-zero exit (callers decide what a non-zero code means).
 * Rejects only on a spawn error (e.g. bin not found).
 */
export function spawnCapture(
  bin: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onData?: (chunk: string) => void } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      opts.onData?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      opts.onData?.(s);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
```

Replace the existing `runSandbox` (currently `async function runSandbox(args, cwd = os.homedir())`) with:

```ts
async function runSandbox(
  args: string[],
  cwd: string = os.homedir(),
  onData?: (chunk: string) => void,
): Promise<{ stdout: string; stderr: string }> {
  const bin = await resolveSandboxBin();
  if (onData) {
    const { stdout, stderr, code } = await spawnCapture(bin, args, { cwd, env: childEnv(), onData });
    if (code !== 0) {
      const detail = stripAnsi((stderr || stdout || "").trim());
      throw new WorkspaceError(`sandbox ${args.join(" ")} failed:\n${detail}`);
    }
    return { stdout, stderr };
  }
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      cwd,
      env: childEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const detail = stripAnsi((err.stderr || err.stdout || err.message || "").trim());
    throw new WorkspaceError(`sandbox ${args.join(" ")} failed:\n${detail}`);
  }
}
```

In `createWorkspace`, widen the opts type and forward `onData`:

```ts
export async function createWorkspace(
  formData: Record<string, unknown>,
  opts: { open?: boolean; onData?: (chunk: string) => void } = {},
): Promise<CreateResult> {
  const args = buildWorkspaceArgs(formData);
  const command = `sandbox ${args.join(" ")}`;
  const { stdout, stderr } = await runSandbox(args, os.homedir(), opts.onData);
  // …everything below this line stays exactly as-is…
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/sandbox-driver && npx tsc && node --test spawn-capture.test.mjs`
Expected: PASS — 3 tests, 0 fail.

- [ ] **Step 5: Add the `test` script**

In `packages/sandbox-driver/package.json`, add to `scripts`:

```json
    "test": "tsc && node --test spawn-capture.test.mjs"
```

- [ ] **Step 6: Verify typecheck is clean**

Run: `cd packages/sandbox-driver && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/sandbox-driver/sandbox.ts packages/sandbox-driver/spawn-capture.test.mjs packages/sandbox-driver/package.json
git commit -m "feat(sandbox-driver): stream createWorkspace via optional onData callback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Plugin — pure schema→field-descriptor mapper

**Files:**
- Create: `apps/claudeck/plugins/sandbox-workspace/parse-form-schema.mjs`
- Test: `apps/claudeck/plugins/sandbox-workspace/parse-form-schema.test.mjs`

**Interfaces:**
- Consumes: the RJSF bundle from `sandbox workspace --print-form-schema` (`{ schema, uiSchema, formData, title }`).
- Produces: `schemaToFields(bundle): Field[]` where
  `Field = { key, title, description, widget: "text"|"select"|"checkboxes"|"textarea", required: boolean, pattern?: string, placeholder?: string, enumOptions: string[], refinable: boolean, refineInstruction?: string }`, ordered per `uiSchema["ui:order"]` (unlisted keys appended in schema order).

- [ ] **Step 1: Write the failing test**

Create `apps/claudeck/plugins/sandbox-workspace/parse-form-schema.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { schemaToFields } from "./parse-form-schema.mjs";

const BUNDLE = {
  schema: {
    type: "object",
    properties: {
      jira_id: { title: "Jira ID", type: "string", pattern: "^$|X" },
      feature: { title: "Feature", type: "string", pattern: "^[a-z]+$", minLength: 1 },
      work_type: { title: "Work type", type: "string", enum: ["feature", "bugfix"] },
      services: { title: "Services", type: "array", items: { type: "string", enum: ["a", "b"] } },
      starting_prompt: { title: "Prompt", type: "string" },
    },
    required: ["feature", "work_type"],
  },
  uiSchema: {
    jira_id: { "ui:placeholder": "PROJ-1234" },
    services: { "ui:widget": "checkboxes" },
    starting_prompt: {
      "ui:widget": "textarea",
      "ui:options": { refinable: true, refineInstruction: "Rewrite it." },
    },
    "ui:order": ["jira_id", "feature", "work_type", "services", "starting_prompt"],
  },
  formData: {},
  title: "Initialize x",
};

test("maps widgets, required, pattern, placeholder", () => {
  const f = schemaToFields(BUNDLE);
  const by = Object.fromEntries(f.map((x) => [x.key, x]));
  assert.equal(by.feature.widget, "text");
  assert.equal(by.feature.required, true);
  assert.equal(by.feature.pattern, "^[a-z]+$");
  assert.equal(by.jira_id.placeholder, "PROJ-1234");
  assert.equal(by.jira_id.required, false);
  assert.equal(by.work_type.widget, "select");
  assert.deepEqual(by.work_type.enumOptions, ["feature", "bugfix"]);
  assert.equal(by.services.widget, "checkboxes");
  assert.deepEqual(by.services.enumOptions, ["a", "b"]);
  assert.equal(by.starting_prompt.widget, "textarea");
  assert.equal(by.starting_prompt.refinable, true);
  assert.equal(by.starting_prompt.refineInstruction, "Rewrite it.");
});

test("respects ui:order", () => {
  const keys = schemaToFields(BUNDLE).map((x) => x.key);
  assert.deepEqual(keys, ["jira_id", "feature", "work_type", "services", "starting_prompt"]);
});

test("appends keys missing from ui:order, in schema order", () => {
  const b = structuredClone(BUNDLE);
  b.uiSchema["ui:order"] = ["feature"];
  const keys = schemaToFields(b).map((x) => x.key);
  assert.equal(keys[0], "feature");
  assert.deepEqual(keys.slice(1).sort(), ["jira_id", "services", "starting_prompt", "work_type"]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test apps/claudeck/plugins/sandbox-workspace/parse-form-schema.test.mjs`
Expected: FAIL — cannot find `schemaToFields`.

- [ ] **Step 3: Implement the mapper**

Create `apps/claudeck/plugins/sandbox-workspace/parse-form-schema.mjs`:

```js
// Pure RJSF-bundle → field-descriptor mapper. No IO. Turns the flat
// `sandbox workspace --print-form-schema` bundle into an ordered list the
// vanilla renderer can walk. Only the widget shapes the workspace schema
// actually uses are modeled (text / select / checkboxes / textarea).

export function schemaToFields(bundle) {
  const schema = bundle?.schema ?? {};
  const uiSchema = bundle?.uiSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);

  const order = orderedKeys(Object.keys(props), uiSchema["ui:order"]);
  return order.map((key) => {
    const p = props[key] ?? {};
    const ui = uiSchema[key] ?? {};
    const uiOpts = ui["ui:options"] ?? {};
    return {
      key,
      title: p.title ?? key,
      description: p.description ?? "",
      widget: widgetFor(p, ui),
      required: required.has(key),
      pattern: typeof p.pattern === "string" ? p.pattern : undefined,
      placeholder: ui["ui:placeholder"],
      enumOptions: enumOptionsFor(p),
      refinable: uiOpts.refinable === true,
      refineInstruction:
        typeof uiOpts.refineInstruction === "string" ? uiOpts.refineInstruction : undefined,
    };
  });
}

function widgetFor(p, ui) {
  if (ui["ui:widget"] === "textarea") return "textarea";
  if (Array.isArray(p.enum)) return "select";
  if (p.type === "array" && Array.isArray(p.items?.enum)) return "checkboxes";
  return "text";
}

function enumOptionsFor(p) {
  if (Array.isArray(p.enum)) return p.enum.map(String);
  if (p.type === "array" && Array.isArray(p.items?.enum)) return p.items.enum.map(String);
  return [];
}

// ui:order first (only keys that exist), then any remaining keys in schema order.
function orderedKeys(allKeys, uiOrder) {
  const seen = new Set();
  const out = [];
  for (const k of Array.isArray(uiOrder) ? uiOrder : []) {
    if (allKeys.includes(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  for (const k of allKeys) if (!seen.has(k)) out.push(k);
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test apps/claudeck/plugins/sandbox-workspace/parse-form-schema.test.mjs`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/claudeck/plugins/sandbox-workspace/parse-form-schema.mjs apps/claudeck/plugins/sandbox-workspace/parse-form-schema.test.mjs
git commit -m "feat(claudeck): schema→field-descriptor mapper for create-workspace form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Plugin server — driver-backed routes

**Files:**
- Modify: `apps/claudeck/package.json` (add dependency)
- Modify: `apps/claudeck/plugins/sandbox-workspace/server.js` (imports + 4 routes)

**Interfaces:**
- Consumes: `sandbox-driver` exports `getFormSchema`, `fetchJiraFormData`, `refinePrompt`, `createWorkspace` (streaming via Task 1's `onData`).
- Produces HTTP routes under `/api/plugins/sandbox-workspace/`:
  - `GET /form-schema` → `{ schema, uiSchema, formData, title }` or `{ error }` (500).
  - `POST /jira-form-data` `{ ref }` → merged form-data object (best-effort; `{}` on failure).
  - `POST /refine-prompt` `{ text, instruction, formData }` → `{ refined }`.
  - `POST /create` `{ formData }` → chunked `text/plain` stream; ends with `\n[workspace] <path>\n[exit 0]\n` on success or `\n[error] <msg>\n[exit 1]\n` on failure.

- [ ] **Step 1: Add the driver dependency and install**

In `apps/claudeck/package.json`, add to `dependencies` (keep alphabetical if the file is sorted):

```json
    "sandbox-driver": "*",
```

Run: `npm install`
Expected: completes; `ls apps/claudeck/node_modules/sandbox-driver` (or root `node_modules/sandbox-driver`) resolves to the workspace package.

- [ ] **Step 2: Verify the driver imports from the plugin context**

Run:
```bash
cd apps/claudeck && node --input-type=module -e "import('sandbox-driver').then(m => console.log(['getFormSchema','fetchJiraFormData','refinePrompt','createWorkspace'].every(k => typeof m[k] === 'function') ? 'OK' : 'MISSING'))"
```
Expected: `OK`. (If it prints an error about missing `dist`, run `cd packages/sandbox-driver && npx tsc` first.)

- [ ] **Step 3: Add the imports**

In `apps/claudeck/plugins/sandbox-workspace/server.js`, add after the existing driver-free imports:

```js
import { getFormSchema, fetchJiraFormData, refinePrompt, createWorkspace } from "sandbox-driver";
import { basename } from "node:path";
```

- [ ] **Step 4: Add the four routes**

In `apps/claudeck/plugins/sandbox-workspace/server.js`, immediately before `export default router;`:

```js
// ── Create Workspace: schema, Jira pre-fill, prompt refine, streamed create ──
// All driver-backed. Best-effort: driver failures degrade to an error payload
// (GET/POST JSON routes) or an [error]/[exit 1] stream tail (create).

router.get("/form-schema", async (_req, res) => {
  try {
    res.json(await getFormSchema());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/jira-form-data", async (req, res) => {
  const ref = typeof req.body?.ref === "string" ? req.body.ref.trim() : "";
  if (!ref) return res.json({});
  try {
    res.json(await fetchJiraFormData(ref));
  } catch {
    res.json({}); // best-effort pre-fill; leave fields as-is on failure
  }
});

router.post("/refine-prompt", async (req, res) => {
  const { text, instruction, formData } = req.body || {};
  try {
    const refined = await refinePrompt(text ?? "", instruction ?? "", formData ?? {});
    res.json({ refined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/create", async (req, res) => {
  const formData = req.body?.formData;
  if (!formData || typeof formData !== "object") {
    return res.status(400).json({ error: "missing formData" });
  }
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  try {
    const result = await createWorkspace(formData, {
      open: false,
      onData: (chunk) => res.write(chunk),
    });
    if (result.workspacePath) res.write(`\n[workspace] ${result.workspacePath}\n`);
    res.end("[exit 0]\n");
  } catch (err) {
    res.write(`\n[error] ${err.message}\n`);
    res.end("[exit 1]\n");
  }
});
```

- [ ] **Step 5: Verify syntax**

Run: `node --check apps/claudeck/plugins/sandbox-workspace/server.js`
Expected: no output (valid).

- [ ] **Step 6: Live-verify the schema route** (requires a claudeck restart)

Restart claudeck, then:
```bash
curl -sS "http://localhost:9009/api/plugins/sandbox-workspace/form-schema" | python3 -c "import sys,json; d=json.load(sys.stdin); print('feature' in d['schema']['properties'])"
```
Expected: `True`.

- [ ] **Step 7: Commit**

```bash
git add apps/claudeck/package.json apps/claudeck/plugins/sandbox-workspace/server.js
git commit -m "feat(claudeck): driver-backed create-workspace routes (schema, jira, refine, create)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Plugin — vanilla create-form renderer

**Files:**
- Create: `apps/claudeck/plugins/sandbox-workspace/create-form.mjs`

**Interfaces:**
- Consumes: `schemaToFields` (Task 2); routes `/form-schema`, `/jira-form-data`, `/refine-prompt`, `/create` (Task 3).
- Produces: `renderCreateForm(container, { onCreated })` — populates `container` with the form; calls `onCreated(workspacePath)` after a successful create. Idempotent: safe to call again to re-render.

- [ ] **Step 1: Implement the renderer**

Create `apps/claudeck/plugins/sandbox-workspace/create-form.mjs`:

```js
// Vanilla schema-driven "Create Workspace" form. Loaded on demand by the core
// Add Project modal. Fetches the RJSF bundle, renders the 4 widget types with
// native HTML5 validation, wires Fetch-from-Jira + Refine, and streams create
// output. All server output is untrusted → DOM via textContent, never innerHTML.
import { schemaToFields } from "./parse-form-schema.mjs";

const BASE = "/api/plugins/sandbox-workspace";
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

export async function renderCreateForm(container, { onCreated } = {}) {
  container.replaceChildren(el("div", "sw-cf-loading", "Loading form…"));

  let bundle;
  try {
    const res = await fetch(`${BASE}/form-schema`);
    if (!res.ok) throw new Error(String(res.status));
    bundle = await res.json();
  } catch {
    container.replaceChildren(
      el("div", "sw-cf-error", "Enable the Sandbox Workspace plugin (and build sandbox-driver)."),
    );
    return;
  }

  const fields = schemaToFields(bundle);
  const inputs = new Map(); // key → { get(), set(v), refineBtn? }

  const form = el("form", "sw-cf-form");
  form.setAttribute("novalidate", ""); // we call reportValidity() ourselves

  for (const f of fields) {
    form.appendChild(buildField(f, inputs, bundle.formData?.[f.key]));
  }

  const output = el("pre", "sw-cf-output hidden");
  const createBtn = el("button", "sw-cf-create", "Create Workspace");
  createBtn.type = "submit";
  form.append(createBtn, output);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return; // native pattern/required validation
    submitCreate(collect(inputs), inputs, createBtn, output, onCreated);
  });

  container.replaceChildren(form);
}

function buildField(f, inputs, initialValue) {
  const row = el("div", "sw-cf-row");
  const label = el("label", "sw-cf-label", f.title);
  row.appendChild(label);
  if (f.description) row.appendChild(el("div", "sw-cf-desc", f.description));

  let control;
  if (f.widget === "select") {
    control = el("select", "sw-cf-input");
    for (const opt of f.enumOptions) {
      const o = el("option", null, opt);
      o.value = opt;
      control.appendChild(o);
    }
    if (initialValue != null) control.value = String(initialValue);
    inputs.set(f.key, { get: () => control.value, set: (v) => (control.value = String(v ?? "")) });
    row.appendChild(control);
  } else if (f.widget === "checkboxes") {
    const box = el("div", "sw-cf-checks");
    const boxes = [];
    const initial = new Set(Array.isArray(initialValue) ? initialValue.map(String) : []);
    for (const opt of f.enumOptions) {
      const wrap = el("label", "sw-cf-check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = opt;
      cb.checked = initial.has(opt);
      wrap.append(cb, el("span", null, opt));
      box.appendChild(wrap);
      boxes.push(cb);
    }
    inputs.set(f.key, {
      get: () => boxes.filter((b) => b.checked).map((b) => b.value),
      set: (v) => {
        const on = new Set(Array.isArray(v) ? v.map(String) : []);
        boxes.forEach((b) => (b.checked = on.has(b.value)));
      },
    });
    row.appendChild(box);
  } else if (f.widget === "textarea") {
    control = el("textarea", "sw-cf-input");
    control.rows = 3;
    if (f.placeholder) control.placeholder = f.placeholder;
    if (f.required) control.required = true;
    if (initialValue != null) control.value = String(initialValue);
    inputs.set(f.key, { get: () => control.value, set: (v) => (control.value = String(v ?? "")) });
    if (f.refinable) row.appendChild(withRefine(control, f, inputs));
    else row.appendChild(control);
  } else {
    control = el("input", "sw-cf-input");
    control.type = "text";
    if (f.placeholder) control.placeholder = f.placeholder;
    if (f.pattern) control.pattern = f.pattern;
    if (f.required) control.required = true;
    if (initialValue != null) control.value = String(initialValue);
    inputs.set(f.key, { get: () => control.value, set: (v) => (control.value = String(v ?? "")) });
    if (f.key === "jira_id") row.appendChild(withJira(control, inputs));
    else row.appendChild(control);
  }
  return row;
}

// jira_id text input + "Fetch from Jira" button that pre-fills other fields.
function withJira(input, inputs) {
  const wrap = el("div", "sw-cf-inline");
  const btn = el("button", "sw-cf-side-btn", "Fetch from Jira");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    const ref = input.value.trim();
    if (!ref) return;
    btn.disabled = true;
    btn.textContent = "Fetching…";
    try {
      const res = await fetch(`${BASE}/jira-form-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref }),
      });
      const data = await res.json();
      for (const [k, v] of Object.entries(data)) inputs.get(k)?.set(v);
    } finally {
      btn.disabled = false;
      btn.textContent = "Fetch from Jira";
    }
  });
  wrap.append(input, btn);
  return wrap;
}

// textarea + "Refine ✨" button that rewrites the draft via the LLM.
function withRefine(textarea, f, inputs) {
  const wrap = el("div", "sw-cf-refine");
  const btn = el("button", "sw-cf-side-btn", "Refine ✨");
  btn.type = "button";
  btn.addEventListener("click", async () => {
    const text = textarea.value.trim();
    if (!text) return;
    btn.disabled = true;
    btn.textContent = "Refining…";
    try {
      const res = await fetch(`${BASE}/refine-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, instruction: f.refineInstruction, formData: collect(inputs) }),
      });
      const data = await res.json();
      if (res.ok && typeof data.refined === "string") textarea.value = data.refined;
    } finally {
      btn.disabled = false;
      btn.textContent = "Refine ✨";
    }
  });
  wrap.append(textarea, btn);
  return wrap;
}

function collect(inputs) {
  const out = {};
  for (const [key, io] of inputs) out[key] = io.get();
  return out;
}

async function submitCreate(formData, inputs, createBtn, output, onCreated) {
  createBtn.disabled = true;
  createBtn.textContent = "Creating…";
  output.classList.remove("hidden");
  output.textContent = "";
  let workspacePath = null;
  try {
    const res = await fetch(`${BASE}/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ formData }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      output.textContent = data.error || `HTTP ${res.status}`;
      return;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      output.append(document.createTextNode(stripAnsi(dec.decode(value, { stream: true }))));
      output.scrollTop = output.scrollHeight;
    }
    workspacePath = /\[workspace\] (.+)/.exec(output.textContent)?.[1]?.trim() || null;
    const ok = /\[exit 0\]/.test(output.textContent);
    if (ok && workspacePath) onCreated?.(workspacePath);
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = "Create Workspace";
  }
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check apps/claudeck/plugins/sandbox-workspace/create-form.mjs`
Expected: no output (valid).

- [ ] **Step 3: Commit**

```bash
git add apps/claudeck/plugins/sandbox-workspace/create-form.mjs
git commit -m "feat(claudeck): vanilla create-workspace form renderer (jira + refine + stream)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Core — tabbed Add Project modal

**Files:**
- Modify: `apps/claudeck/public/js/components/add-project-modal.js` (tab bar + panels + scoped style)
- Modify: `apps/claudeck/public/js/features/projects.js` (tab switch + lazy import + post-create glue)
- Modify: `apps/claudeck/VENDORED.md`

**Interfaces:**
- Consumes: `renderCreateForm(container, { onCreated })` from `/plugins/sandbox-workspace/create-form.mjs` (Task 4); existing `api.addProject`, `loadProjects`, `$.projectSelect`, `closeAddProjectModal`.

- [ ] **Step 1: Add the tab bar, panels, and scoped styles to the modal markup**

In `apps/claudeck/public/js/components/add-project-modal.js`, replace the `innerHTML` template's body (the `<div class="modal-header">…</div>` through the end of `<div class="add-project-body">…</div>`) with a tabbed version. Wrap the **existing** folder-browser markup unchanged inside `#ap-panel-folder`, and add an empty `#ap-panel-create` mount:

```js
    this.innerHTML = `
  <div id="add-project-modal" class="modal-overlay hidden">
    <div class="modal add-project-modal">
      <style>
        .ap-tabs { display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid var(--border); }
        .ap-tab { background: none; border: none; color: var(--text-secondary); font: inherit;
          padding: 8px 12px; cursor: pointer; border-bottom: 2px solid transparent; }
        .ap-tab.active { color: var(--text); border-bottom-color: var(--accent); }
        .ap-panel.hidden { display: none; }
        .sw-cf-form { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
        .sw-cf-row { display: flex; flex-direction: column; gap: 4px; }
        .sw-cf-label { font-size: 12px; font-weight: 600; }
        .sw-cf-desc { font-size: 11px; color: var(--text-dim); }
        .sw-cf-input { background: var(--bg); color: var(--text); border: 1px solid var(--border);
          border-radius: var(--radius); padding: 6px 8px; font: inherit; }
        .sw-cf-input:invalid { border-color: var(--error); }
        .sw-cf-checks { display: flex; flex-wrap: wrap; gap: 10px; }
        .sw-cf-check { display: flex; align-items: center; gap: 4px; font-size: 12px; }
        .sw-cf-inline, .sw-cf-refine { display: flex; gap: 6px; align-items: flex-start; }
        .sw-cf-inline .sw-cf-input, .sw-cf-refine .sw-cf-input { flex: 1; }
        .sw-cf-side-btn { white-space: nowrap; background: var(--bg-tertiary); color: var(--text);
          border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px; cursor: pointer; }
        .sw-cf-side-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .sw-cf-create { background: var(--accent); color: var(--bg); border: none;
          border-radius: var(--radius); padding: 8px; font-weight: 600; cursor: pointer; }
        .sw-cf-create:disabled { opacity: 0.6; cursor: not-allowed; }
        .sw-cf-output { background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--radius);
          padding: 8px; font-size: 11px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; margin: 0; }
        .sw-cf-loading, .sw-cf-error { padding: 16px; color: var(--text-dim); font-size: 12px; }
        .hidden { display: none; }
      </style>
      <div class="modal-header">
        <h3>Add Project</h3>
        <button id="add-project-close" class="modal-close">&times;</button>
      </div>
      <div class="ap-tabs">
        <button id="ap-tab-folder" class="ap-tab active" type="button">Open Folder</button>
        <button id="ap-tab-create" class="ap-tab" type="button">Create Workspace</button>
      </div>
      <div id="ap-panel-folder" class="ap-panel add-project-body">
        <div class="folder-path-row">
          <input id="folder-path-input" type="text" placeholder="Type a path (e.g. ~/code/my-app) and press Enter" autocomplete="off" spellcheck="false">
          <button id="folder-path-go" class="folder-path-go" title="Go to path">Go</button>
        </div>
        <div id="folder-recents" class="folder-recents hidden"></div>
        <div id="folder-breadcrumb" class="folder-breadcrumb"></div>
        <div id="folder-list" class="folder-list"></div>
        <div id="folder-new-row" class="folder-new-row hidden">
          <input id="folder-new-name" type="text" placeholder="New folder name" autocomplete="off" spellcheck="false">
          <button id="folder-new-create" class="modal-btn-save">Create</button>
          <button id="folder-new-cancel" class="modal-btn-cancel">Cancel</button>
        </div>
        <div id="folder-new-toggle-row" class="folder-new-toggle-row">
          <button id="folder-new-toggle" class="folder-new-toggle" type="button">+ New folder here</button>
        </div>
        <div id="add-project-message" class="add-project-message hidden"></div>
        <div class="folder-select-row">
          <input id="add-project-name" type="text" placeholder="Project name" autocomplete="off">
          <button id="add-project-confirm" class="modal-btn-save">Add</button>
        </div>
      </div>
      <div id="ap-panel-create" class="ap-panel hidden"></div>
    </div>
  </div>`;
```

Leave the `connectedCallback` close-button wiring below the template exactly as-is.

- [ ] **Step 2: Wire tab switching + lazy create-form load in projects.js**

In `apps/claudeck/public/js/features/projects.js`, add near the other modal listeners (after the `$.addProjectConfirm.addEventListener(...)` block, around line 490). This uses direct `getElementById` (these tab elements aren't in the `$` cache):

```js
// ── Add Project modal: Open Folder / Create Workspace tabs ──────────────────
let createFormLoaded = false;
const apTabFolder = document.getElementById("ap-tab-folder");
const apTabCreate = document.getElementById("ap-tab-create");
const apPanelFolder = document.getElementById("ap-panel-folder");
const apPanelCreate = document.getElementById("ap-panel-create");

function selectAddProjectTab(which) {
  const folder = which === "folder";
  apTabFolder.classList.toggle("active", folder);
  apTabCreate.classList.toggle("active", !folder);
  apPanelFolder.classList.toggle("hidden", !folder);
  apPanelCreate.classList.toggle("hidden", folder);
  if (!folder && !createFormLoaded) {
    createFormLoaded = true;
    loadCreateForm();
  }
}

async function loadCreateForm() {
  try {
    const mod = await import("/plugins/sandbox-workspace/create-form.mjs");
    await mod.renderCreateForm(apPanelCreate, { onCreated: onWorkspaceCreated });
  } catch {
    apPanelCreate.textContent = "Enable the Sandbox Workspace plugin to create workspaces.";
    createFormLoaded = false; // allow a retry on next tab open
  }
}

async function onWorkspaceCreated(path) {
  const name = path.replace(/\/+$/, "").split("/").pop();
  await api.addProject(name, path);
  await loadProjects();
  $.projectSelect.value = path;
  $.projectSelect.dispatchEvent(new Event("change"));
  closeAddProjectModal();
}

apTabFolder.addEventListener("click", () => selectAddProjectTab("folder"));
apTabCreate.addEventListener("click", () => selectAddProjectTab("create"));
```

Confirm `api` is already imported in `projects.js` (it is — `addProject`/`browseFolders` are used). If `api` is imported as named functions rather than a namespace, use `addProject(name, path)` directly instead of `api.addProject`. Check the file's existing import line and match it.

- [ ] **Step 3: Verify syntax of both core files**

Run:
```bash
node --check apps/claudeck/public/js/components/add-project-modal.js
node --check apps/claudeck/public/js/features/projects.js
```
Expected: no output (both valid).

- [ ] **Step 4: Record the core edits in VENDORED.md**

In `apps/claudeck/VENDORED.md`, under "Local modifications", append:

```markdown
- **Create Workspace** (project-layer feature): the core Add Project modal
  (`public/js/components/add-project-modal.js`) is now a two-tab modal
  (Open Folder | Create Workspace), with tab-switch + post-create glue in
  `public/js/features/projects.js`. The Create tab lazy-imports the
  sandbox-workspace plugin's `create-form.mjs`; the plugin gained a
  `sandbox-driver` dependency and routes (`form-schema`, `jira-form-data`,
  `refine-prompt`, `create`). `sandbox-driver` must be built (`tsc`) before
  claudeck runs.
```

- [ ] **Step 5: Commit**

```bash
git add apps/claudeck/public/js/components/add-project-modal.js apps/claudeck/public/js/features/projects.js apps/claudeck/VENDORED.md
git commit -m "feat(claudeck): two-tab Add Project modal with Create Workspace

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Live acceptance

**Files:** none (verification only)

- [ ] **Step 1: Ensure the driver is built and restart claudeck**

Run: `cd packages/sandbox-driver && npx tsc && echo built`
Then restart claudeck (`cd apps/claudeck && node cli.js --port 9009 --no-auth`).

- [ ] **Step 2: Verify the full flow in the browser**

1. Open `http://localhost:9009`, click **Add Project** → the modal shows two tabs.
2. **Open Folder** tab works exactly as before (browse + Add).
3. **Create Workspace** tab renders the form (feature, work_type select, services checkboxes, starting_prompt textarea with **Refine ✨**, jira_id with **Fetch from Jira**).
4. Native validation: submitting with an empty `feature` or bad pattern is blocked by the browser.
5. Enter a throwaway `feature` (e.g. `plan-smoke`) + a `work_type`, click **Create Workspace** → output streams live; on success the modal closes and the new workspace is selected in the project picker.
6. (Optional) One **Fetch from Jira** with a real ticket pre-fills fields; one **Refine ✨** rewrites the prompt.

- [ ] **Step 3: Confirm no regressions**

Run: `node --test apps/claudeck/plugins/sandbox-workspace/*.test.mjs`
Expected: all pass (mapper + existing parsers).
Run: `cd packages/sandbox-driver && npm test`
Expected: spawn-capture tests pass.

- [ ] **Step 4: Clean up the smoke workspace** (if created)

Remove the throwaway workspace via the CLI (`sandbox down` in its dir, then delete), or leave it if useful.

---

## Self-Review notes

- **Spec coverage:** driver streaming (Task 1) ✓; schema render (Task 2 mapper + Task 4 renderer) ✓; 4 routes (Task 3) ✓; tabbed core modal + post-create glue (Task 5) ✓; error/degradation paths (Task 3 best-effort + Task 4 fallbacks + Task 5 import catch) ✓; testing (Task 1 + Task 2 units, Task 6 live) ✓; VENDORED.md (Task 5) ✓.
- **Native validation** via HTML5 `pattern`/`required` (Task 4) ✓.
- **Schema-driven affordances** (Jira button on `jira_id`, Refine on `refinable`) ✓.
- **Type consistency:** `renderCreateForm(container, { onCreated })`, `onCreated(workspacePath)`, `schemaToFields(bundle) → Field[]`, `createWorkspace(formData, { open, onData })`, `spawnCapture(bin, args, { cwd, env, onData })` — used consistently across tasks.
