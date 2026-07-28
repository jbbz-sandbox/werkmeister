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
