/**
 * Convert a prompt spec into an RJSF JSON Schema + uiSchema.
 *
 * This is the shared home for prompt → JSON Schema conversion. `getFormSchema`
 * (sandbox.ts) runs it over `computePromptSpec`'s output to build the create
 * form, so the terminal wizard, the MCP elicitation adapter, and the form all
 * derive from the same prompt definitions.
 *
 * Input is a prompt spec: `{"workspace_name": str, "prompts": [ {prompt}, ... ]}`
 * where each prompt is the dict `promptEntry` (workspace_prompts.ts) emits (key, label, help,
 * accept_empty, multi, recommended, pattern?, placeholder?, default, resolved,
 * resolved_value, choices?).
 *
 * Output: `{"schema": {...}, "uiSchema": {...}, "formData": {...}, "title": str}`.
 *
 * Mapping:
 *     multi + choices  → array of enum  (uiSchema ui:widget=checkboxes; choice_groups
 *                                         → ui:options.groups {group: [choices]})
 *     multi w/o choices → string        (free-form, user types comma-separated text —
 *                                         there's no RJSF array widget wired up in the
 *                                         renderers, so this stays a plain text input)
 *     choices (single) → string enum    (dropdown)
 *     multiline        → string         (uiSchema ui:widget=textarea)
 *     multiline+refinable → string      (ui:widget=textarea + ui:options.refinable; the
 *                                         refine_instruction → ui:options.refineInstruction.
 *                                         Standard widget — form-ui enhances its own textarea
 *                                         when it sees the flag; other renderers ignore it.)
 *     otherwise        → string
 *     accept_empty False OR recommended → required (+ minLength 1 for strings)
 *     pattern          → JSON Schema `pattern` (string fields). Optional fields OR-in
 *                        empty (`^$|(?:…)`) so a blank optional input doesn't error
 *                        (AJV applies `pattern` to any string, including "").
 *     placeholder      → uiSchema `ui:placeholder`
 *     resolved: true   → omitted (already filled from CLI/env/config/.env; re-resolved
 *                        when the command runs)
 */

type Prompt = Record<string, any>;

function _default(prompt: Prompt): any {
  let value = prompt["resolved_value"];
  if (value === null || value === undefined || value === "") {
    value = prompt["default"];
  }
  return value || "";
}

function _required(prompt: Prompt): boolean {
  return prompt["accept_empty"] === false || Boolean(prompt["recommended"]);
}

/** Apply the type-specific JSON-Schema/uiSchema for one prompt; return formData. */
function _shape(
  prompt: Prompt,
  defaultValue: any,
  prop: Record<string, any>,
  fieldUi: Record<string, any>,
): any {
  const choices = prompt["choices"];
  // An absent or EMPTY choices list falls through to the free-text shape.
  const hasChoices = Array.isArray(choices) && choices.length > 0;
  if (prompt["multi"] && hasChoices) {
    Object.assign(prop, {
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: choices },
    });
    fieldUi["ui:widget"] = "checkboxes";
    if (prompt["choice_groups"]) {
      // group → choices, e.g. services under their repo. Renderers that don't
      // know the option show the flat enum.
      fieldUi["ui:options"] = { groups: prompt["choice_groups"] };
    }
    if (defaultValue) {
      return String(defaultValue).split(",").map((s) => s.trim()).filter((s) => s);
    }
    return null;
  }
  if (hasChoices) {
    Object.assign(prop, { type: "string", enum: choices });
    return defaultValue || null;
  }
  prop["type"] = "string";
  if (prompt["multiline"]) {
    // Always the STANDARD textarea widget so every RJSF renderer (form-ui's
    // browser form, the MCP App, …) can render it. Refinability is carried in
    // ui:options, NOT a custom ui:widget name — form-ui enhances its own textarea
    // widget when it sees the flag; renderers that don't know it ignore the option.
    fieldUi["ui:widget"] = "textarea";
    if (prompt["refinable"]) {
      const opts: Record<string, any> = { refinable: true };
      if (prompt["refine_instruction"]) {
        opts["refineInstruction"] = prompt["refine_instruction"];
      }
      fieldUi["ui:options"] = opts;
    }
  }
  return defaultValue || null;
}

/** Build one prompt's (json-schema prop, uiSchema entry, formData value, required). */
function _field(prompt: Prompt): [Record<string, any>, Record<string, any>, any, boolean] {
  const prop: Record<string, any> = { title: prompt["label"] || prompt["key"] };
  if (prompt["help"]) {
    prop["description"] = prompt["help"];
  }
  const fieldUi: Record<string, any> = {};
  const defaultValue = _default(prompt);
  const data = _shape(prompt, defaultValue, prop, fieldUi);

  const required = _required(prompt);
  const pattern = prompt["pattern"];
  if (pattern && prop["type"] === "string" && !("enum" in prop)) {
    prop["pattern"] = required ? pattern : `^$|(?:${pattern})`;
  }
  if (prompt["placeholder"]) {
    fieldUi["ui:placeholder"] = prompt["placeholder"];
  }
  if (required && prop["type"] === "string") {
    prop["minLength"] = 1;
  }

  return [prop, fieldUi, data, required];
}

/**
 * Convert a prompt spec → {schema, uiSchema, formData, title}.
 *
 * Only unresolved prompts become form fields; resolved ones are omitted (the
 * command re-resolves them itself). `title` overrides the derived
 * "Initialize <name>".
 */
export function buildFormSchema(
  spec: Record<string, any>,
  title?: string | null,
): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const order: string[] = [];
  const uiSchema: Record<string, any> = {};
  const formData: Record<string, any> = {};

  for (const prompt of spec["prompts"] ?? []) {
    if (prompt["resolved"]) {
      continue;
    }
    const key = prompt["key"];
    order.push(key);
    const [prop, fieldUi, data, isRequired] = _field(prompt);
    properties[key] = prop;
    if (data !== null) {
      formData[key] = data;
    }
    if (isRequired) {
      required.push(key);
    }
    if (order.length === 1) { // first rendered field
      fieldUi["ui:autofocus"] = true;
    }
    if (Object.keys(fieldUi).length) {
      uiSchema[key] = fieldUi;
    }
  }

  const name = spec["workspace_name"] || "workspace";
  const resolvedTitle = title || `Initialize ${name}`;
  const schema: Record<string, any> = {
    type: "object",
    title: resolvedTitle,
    properties,
  };
  if (required.length) {
    schema["required"] = required;
  }
  if (order.length) {
    uiSchema["ui:order"] = order;
  }

  return {
    schema,
    uiSchema,
    formData,
    title: resolvedTitle,
  };
}

/** A workspace needs at least one repo: a selected service or an explicit repo. The message, or null when satisfied. */
export function repoSelectionError(formData: Record<string, unknown>): string | null {
  const picked = (v: unknown) => (Array.isArray(v) ? v.filter(Boolean).length : 0);
  if (picked(formData["services"]) + picked(formData["repos"]) > 0) return null;
  return "Select at least one service (or add a repo below) — a workspace needs at least one repo.";
}

const blank = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/**
 * Field key → why `formData` can't be submitted against a `buildFormSchema` bundle: required, pattern and choices,
 * plus `repoSelectionError` (under `services`). Empty when it can. For renderers without a JSON Schema validator
 * (the /workspaces pane); the browser form's AJV covers the schema part and calls `repoSelectionError` itself.
 */
export function validateFormData(
  bundle: { schema: Record<string, any> },
  formData: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required = new Set<string>(bundle.schema["required"] ?? []);
  for (const [key, prop] of Object.entries<Record<string, any>>(bundle.schema["properties"] ?? {})) {
    const v = formData[key];
    if (blank(v)) {
      if (required.has(key)) errors[key] = "required";
      continue;
    }
    const allowed: unknown[] | undefined = prop["type"] === "array" ? prop["items"]?.["enum"] : prop["enum"];
    const bad = allowed ? (Array.isArray(v) ? v : [v]).filter((x) => !allowed.includes(x)) : [];
    if (bad.length) errors[key] = `not offered: ${bad.join(", ")}`;
    else if (prop["pattern"] && typeof v === "string" && !new RegExp(prop["pattern"]).test(v)) {
      errors[key] = `"${v}" doesn't match the expected format`;
    }
  }
  const repo = repoSelectionError(formData);
  if (repo && !errors["services"]) errors["services"] = repo;
  return errors;
}

/**
 * Fill-empty merge of an issue's fields into form data: a field already filled is never clobbered, so re-fetching
 * is safe. `issue_id` is the exception — the lookup normalizes it (`api#7` → `acme/api#7`), so the canonical ref wins.
 */
export function mergeFormData(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...current };
  for (const [k, v] of Object.entries(incoming)) {
    if (!blank(v) && blank(out[k])) out[k] = v;
  }
  if (typeof incoming["issue_id"] === "string" && incoming["issue_id"]) out["issue_id"] = incoming["issue_id"];
  return out;
}
