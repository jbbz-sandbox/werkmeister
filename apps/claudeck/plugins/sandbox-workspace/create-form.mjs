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
  const inputs = new Map(); // key → { get(), set(v) }

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
  // Associate the label with its control (a11y). Not applicable to the
  // checkbox group — its per-option labels already wrap their inputs.
  if (control) {
    control.id = "sw-cf-" + f.key;
    label.htmlFor = control.id;
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
      if (!res.ok) return;
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
