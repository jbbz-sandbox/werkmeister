/**
 * Convert the `--print-prompts` contract into an RJSF JSON Schema + uiSchema.
 *
 * This is the shared, in-repo home for prompt → JSON Schema conversion. Any
 * subcommand that builds a prompt spec (see `init_workspace._build_prompt_spec`)
 * can expose a `--print-form-schema` flag that emits a standard, render-ready
 * bundle via `buildFormSchema`. The browser-form tool (`form-ui`) consumes the
 * bundle directly, so the CLI — not the skill — owns the schema, and the terminal
 * wizard, the MCP elicitation adapter, and the form all derive from the same
 * prompt definitions.
 *
 * Input is a prompt spec: `{"workspace_name": str, "prompts": [ {prompt}, ... ]}`
 * where each prompt is the dict `_build_prompt_spec` emits (key, label, help,
 * accept_empty, multi, recommended, pattern?, placeholder?, default, resolved,
 * resolved_value, choices?).
 *
 * Output: `{"schema": {...}, "uiSchema": {...}, "formData": {...}, "title": str}`.
 *
 * Mapping:
 *     multi + choices  → array of enum  (uiSchema ui:widget=checkboxes)
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
  // Python truthiness: an absent or EMPTY choices list falls through.
  const hasChoices = Array.isArray(choices) && choices.length > 0;
  if (prompt["multi"] && hasChoices) {
    Object.assign(prop, {
      type: "array",
      uniqueItems: true,
      items: { type: "string", enum: choices },
    });
    fieldUi["ui:widget"] = "checkboxes";
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
