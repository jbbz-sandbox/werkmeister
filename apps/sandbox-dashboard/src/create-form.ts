/**
 * THE create-workspace form — the single implementation every surface renders:
 *   • the browser dashboard's "New workspace" tab (src/browser-main.ts),
 *   • the localhost fallback page (src/form-main.ts), and
 *   • the Desktop inline MCP App (src/mcp-app.ts).
 * All three differ only in the {@link HostBridge} they pass in; the form and
 * its neutral palette (matching src/workspace-ui.ts) are identical everywhere.
 *
 * It fetches the RJSF bundle via `workspace-form-schema` and creates via
 * `create-workspace`, both through the bridge. On success it calls
 * `onCreated(resultText)` — the dashboard flips back to the Workspaces tab,
 * the Desktop app forwards the text to `updateModelContext`.
 */
import Form, { getDefaultRegistry } from "@rjsf/core";
import validator from "@rjsf/validator-ajv8";
import type {
  FormValidation,
  RJSFSchema,
  RJSFValidationError,
  UiSchema,
  WidgetProps,
} from "@rjsf/utils";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostBridge } from "./workspace-ui.js";
import { injectCss } from "./theme.js";
import { mergeFormData, repoSelectionError } from "sandbox-core/form_schema";

// Neutral form styling scoped under `.wsform` so it matches src/workspace-ui.ts
// (same shared --sd-* tokens, src/theme.ts) and never collides with the list's
// `.wsui` rules. Targets @rjsf/core's default-theme class names.
const CSS = `
  .wsform, .wsform * { box-sizing: border-box; }
  .wsform {
    font-family: var(--sd-sans);
    color: var(--sd-ink); padding: 20px;
  }
  .wsform .card {
    background: var(--sd-card); border: 1px solid var(--sd-line); border-radius: 10px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04); padding: 20px;
  }
  .wsform h1 { margin: 0 0 4px; font-size: 18px; }
  .wsform .subtitle { color: var(--sd-muted); font-size: 13px; margin: 0 0 18px; }
  .wsform code { font-family: var(--sd-mono); font-size: 0.88em; }
  .wsform .boot, .wsform .err { color: var(--sd-muted); font-size: 14px; padding: 8px 0; }
  .wsform .err { color: var(--sd-err); }

  .wsform .form-group { margin-bottom: 14px; }
  .wsform .form-group.field-object > fieldset { border: none; margin: 0; padding: 0; }
  .wsform legend { display: none; }
  .wsform label, .wsform label.control-label, .wsform .checkboxes > legend {
    display: block; font-weight: 600; color: var(--sd-ink); margin-bottom: 5px; font-size: 13px;
  }
  .wsform .field-description, .wsform .help-block {
    display: block; color: var(--sd-faint); font-size: 12px; margin: 2px 0 6px;
  }
  .wsform .required { color: var(--sd-err); margin-left: 2px; }

  .wsform input[type="text"], .wsform input[type="number"], .wsform input:not([type]), .wsform textarea {
    width: 100%; max-width: 560px; padding: 8px 12px; border: 1px solid var(--sd-ctl-border); border-radius: 8px;
    background: var(--sd-card); color: var(--sd-ink); font-family: inherit; font-size: 14px;
    transition: border-color 0.12s ease, box-shadow 0.12s ease;
  }
  .wsform textarea { line-height: 1.5; resize: vertical; }
  .wsform input::placeholder, .wsform textarea::placeholder { color: var(--sd-ghost); }
  .wsform input[type="text"]:focus-visible, .wsform textarea:focus-visible, .wsform input:not([type]):focus-visible {
    outline: none; border-color: var(--sd-accent); box-shadow: 0 0 0 3px rgba(217,119,87,0.2);
  }

  /* Grid so the bulky Local services (18) / Additional repos (10) groups flow
     multi-column and fill the wide column instead of one long scroll. */
  .wsform .checkboxes { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 16px; }
  .wsform .checkbox { display: block; }
  .wsform .checkgroup + .checkgroup { margin-top: 10px; }
  .wsform .checkgroup-heading {
    font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--sd-ghost); margin-bottom: 4px;
  }
  .wsform .checkbox label, .wsform .radio label {
    display: flex; align-items: center; gap: 6px; font-weight: 400; font-size: 13px; color: var(--sd-ink); margin-bottom: 0;
  }
  .wsform .checkbox input, .wsform .checkboxes input, .wsform .radio input { width: auto; accent-color: var(--sd-accent); }

  .wsform .refine-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .wsform .refine-btn {
    flex: none; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
    background: var(--sd-card); color: #b85c3c; border: 1px solid var(--sd-accent); border-radius: 6px;
  }
  .wsform .refine-btn:hover { background: #fdf2ee; }
  .wsform .refine-btn:disabled { color: var(--sd-ghost); border-color: var(--sd-ctl-border); cursor: default; }
  .wsform .refine-err { color: var(--sd-err); font-size: 12px; font-weight: 500; }
  .wsform .refine-note { color: var(--sd-ok); font-size: 12px; font-weight: 500; }

  .wsform .text-danger, .wsform .error-detail {
    color: var(--sd-err); font-size: 12px; margin-top: 4px; font-weight: 500; list-style: none; padding: 0;
  }
  .wsform .panel.errors, .wsform .panel-danger { display: none; }
  .wsform .field-error label.control-label, .wsform .has-error label.control-label,
  .wsform .field-error .checkboxes > legend, .wsform .has-error .checkboxes > legend { color: var(--sd-err); }
  .wsform .field-error input[type="text"], .wsform .field-error textarea,
  .wsform .has-error input[type="text"], .wsform .has-error textarea { border-color: #e07a6a; }

  .wsform .actions { margin-top: 18px; display: flex; align-items: center; gap: 14px; }
  .wsform .checkrow { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--sd-ink); }
  .wsform .checkrow input { accent-color: var(--sd-accent); width: 16px; height: 16px; }
  .wsform button.cancelbtn {
    font: inherit; font-weight: 600; padding: 8px 18px; border: 1px solid var(--sd-ctl-border); border-radius: 8px;
    background: var(--sd-card); color: var(--sd-muted); cursor: pointer;
  }
  .wsform button.cancelbtn:hover { color: var(--sd-ink); border-color: var(--sd-ghost); }
  .wsform button.submit {
    font: inherit; font-weight: 600; padding: 8px 18px; border: 1px solid var(--sd-accent); border-radius: 8px;
    background: var(--sd-accent); color: #fff; cursor: pointer; margin-left: auto;
  }
  .wsform button.submit:hover { background: var(--sd-accent-hover); }
  .wsform button.submit:disabled { opacity: 0.55; cursor: default; }

  .wsform .result {
    margin-top: 16px; padding: 10px 12px; border-radius: 8px; white-space: pre-wrap;
    font-size: 12px; font-family: var(--sd-mono); border: 1px solid transparent;
  }
  .wsform .result.ok { background: var(--sd-ok-bg); color: var(--sd-ok); border-color: var(--sd-ok-border); }
  .wsform .result.err { background: var(--sd-err-bg); color: var(--sd-err); border-color: var(--sd-err-border); }
`;

interface FormBundle {
  schema: RJSFSchema;
  uiSchema: UiSchema;
  formData: Record<string, unknown>;
  title: string;
}

const e = React.createElement;

const StockCheckboxes = getDefaultRegistry().widgets.CheckboxesWidget;

/**
 * Checkboxes that honour `ui:options.groups` ({heading: [values]}) — e.g. local
 * services under the repo that owns them, as the terminal wizard lists them.
 * Each group is RJSF's own CheckboxesWidget over that group's options (its
 * select/deselect keep the other groups' picks); anything no group names goes
 * last under "other". Without groups it is the stock widget.
 */
export function GroupedCheckboxesWidget(props: WidgetProps): React.ReactElement<any> {
  const groups = props.options.groups as Record<string, string[]> | undefined;
  if (!groups) {
    return e(StockCheckboxes, props);
  }
  const all = props.options.enumOptions ?? [];
  const named = new Set(Object.values(groups).flat());
  const sections: [string, unknown[]][] = [
    ...Object.entries(groups),
    ["other", all.map((o) => o.value).filter((v) => !named.has(v as string))],
  ];
  return e(
    "div",
    { className: "checkgroups" },
    sections
      .filter(([, values]) => values.length)
      .map(([heading, values], i) =>
        e(
          "div",
          { key: heading, className: "checkgroup" },
          e("div", { className: "checkgroup-heading" }, heading),
          e(StockCheckboxes, {
            ...props,
            // Option ids are `${id}-${index}`; a per-group id keeps them unique.
            id: i === 0 ? props.id : `${props.id}__${i}`,
            autofocus: props.autofocus && i === 0,
            options: { ...props.options, enumOptions: all.filter((o) => values.includes(o.value)) },
          }),
        ),
      ),
  );
}

/** Textarea widget with the "Refine with Claude" button (opt-in via ui:options.refinable). */
function makeTextareaWidget(bridge: HostBridge) {
  return function TextareaWidget(props: WidgetProps): React.ReactElement<any> {
    const { id, value, disabled, readonly, onChange, onBlur, onFocus, options, placeholder, autofocus, formContext } =
      props;
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const opts = (options ?? {}) as {
      rows?: number;
      refinable?: boolean;
      refineInstruction?: string;
      emptyValue?: unknown;
    };
    const rows = opts.rows ?? 5;
    const text = value == null ? "" : String(value);
    const showButton = Boolean(opts.refinable);

    async function refine(): Promise<void> {
      setBusy(true);
      setErr(null);
      try {
        const getFormData = (formContext as { getFormData?: () => Record<string, unknown> } | undefined)?.getFormData;
        const liveFormData = getFormData ? getFormData() : {};
        const res = await bridge.callTool("refine-prompt", {
          text,
          instruction: opts.refineInstruction ?? "",
          formData: liveFormData,
        });
        const refined = String(res?.refined ?? "").trim();
        if (refined) onChange(refined);
        else setErr("The model returned no text.");
      } catch (ex) {
        setErr((ex as Error).message || "Refine failed.");
      } finally {
        setBusy(false);
      }
    }

    return e(
      "div",
      null,
      e("textarea", {
        id,
        value: text,
        rows,
        placeholder: placeholder || "",
        disabled,
        readOnly: readonly,
        autoFocus: autofocus,
        onChange: (ev: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange(ev.target.value === "" ? opts.emptyValue : ev.target.value),
        onBlur: onBlur ? (ev: React.FocusEvent<HTMLTextAreaElement>) => onBlur(id, ev.target.value) : undefined,
        onFocus: onFocus ? (ev: React.FocusEvent<HTMLTextAreaElement>) => onFocus(id, ev.target.value) : undefined,
      }),
      showButton
        ? e(
            "div",
            { className: "refine-row" },
            e(
              "button",
              {
                type: "button",
                className: "refine-btn",
                onClick: refine,
                disabled: busy || disabled || readonly || !text.trim(),
              },
              busy ? "Refining…" : "✨ Refine with Claude",
            ),
            err ? e("span", { className: "refine-err" }, err) : null,
          )
        : null,
    );
  };
}

/**
 * Text widget for `issue_id` with a "Fetch from <tracker>" button (opt-in via
 * ui:widget "issue"). The tracker's label arrives in `ui:options.trackerLabel`,
 * set server-side where the bundle is built.
 */
function makeIssueWidget(bridge: HostBridge) {
  return function IssueWidget(props: WidgetProps): React.ReactElement<any> {
    const { id, value, disabled, readonly, onChange, onBlur, onFocus, placeholder, autofocus, formContext, options } = props;
    const trackerLabel = typeof options?.trackerLabel === "string" ? options.trackerLabel : "";
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const text = value == null ? "" : String(value);

    async function fetchIssue(): Promise<void> {
      setBusy(true);
      setErr(null);
      setNote(null);
      try {
        const res = await bridge.callTool("issue-form-data", { ref: text });
        const data = ((res?.formData ?? {}) as Record<string, unknown>) || {};
        const apply = (formContext as { applyIssueData?: (d: Record<string, unknown>) => void } | undefined)
          ?.applyIssueData;
        if (apply) apply(data);
        const key = typeof data.issue_id === "string" ? data.issue_id : "";
        const filled = Object.keys(data).filter((k) => k !== "issue_id");
        setNote(
          key
            ? filled.length
              ? `Filled ${filled.join(", ")} from ${key}.`
              : `Found ${key}, but no fields to fill.`
            : "No issue found in that value.",
        );
      } catch (ex) {
        setErr((ex as Error).message || "Lookup failed.");
      } finally {
        setBusy(false);
      }
    }

    return e(
      "div",
      null,
      e("input", {
        id,
        type: "text",
        value: text,
        placeholder: placeholder || "",
        disabled,
        readOnly: readonly,
        autoFocus: autofocus,
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) => onChange(ev.target.value === "" ? undefined : ev.target.value),
        onBlur: onBlur ? (ev: React.FocusEvent<HTMLInputElement>) => onBlur(id, ev.target.value) : undefined,
        onFocus: onFocus ? (ev: React.FocusEvent<HTMLInputElement>) => onFocus(id, ev.target.value) : undefined,
      }),
      e(
        "div",
        { className: "refine-row" },
        e(
          "button",
          {
            type: "button",
            className: "refine-btn",
            onClick: fetchIssue,
            disabled: busy || disabled || readonly || !text.trim(),
          },
          busy ? "Fetching…" : trackerLabel ? `⤓ Fetch from ${trackerLabel}` : "⤓ Fetch issue",
        ),
        err ? e("span", { className: "refine-err" }, err) : note ? e("span", { className: "refine-note" }, note) : null,
      ),
    );
  };
}

/** A workspace needs at least one repo; the rule lives in sandbox-core so every create form shares it. */
function validateRepoSelection(formData: unknown, errors: FormValidation): FormValidation {
  const message = repoSelectionError((formData ?? {}) as Record<string, unknown>);
  if (message) errors.services?.addError(message);
  return errors;
}

/** Humanize the validator's terse messages; reuse the field's placeholder as the format example. */
function transformErrors(errors: RJSFValidationError[], uiSchema?: UiSchema): RJSFValidationError[] {
  return errors.map((err) => {
    const key = (err.property ?? "").replace(/^\./, "");
    const placeholder = (uiSchema?.[key] as { "ui:placeholder"?: string } | undefined)?.["ui:placeholder"];
    if (err.name === "required" || err.name === "minLength") {
      err.message = "This field is required.";
    } else if (err.name === "pattern") {
      err.message = placeholder
        ? `Doesn’t match the required format (e.g. ${placeholder}).`
        : "Doesn’t match the required format.";
    }
    return err;
  });
}

function WorkspaceForm({
  bundle,
  bridge,
  onCreated,
  onCancel,
}: {
  bundle: FormBundle;
  bridge: HostBridge;
  onCreated: (resultText: string) => void;
  onCancel?: () => void;
}): React.ReactElement<any> {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [result, setResult] = useState<{ text: string; kind: "ok" | "err" } | null>(null);
  const [formData, setFormData] = useState<Record<string, unknown>>(bundle.formData);
  const formDataRef = React.useRef(formData);
  formDataRef.current = formData;

  const TextareaWidget = React.useMemo(() => makeTextareaWidget(bridge), [bridge]);
  const IssueWidget = React.useMemo(() => makeIssueWidget(bridge), [bridge]);

  async function onSubmit({ formData }: { formData?: unknown }): Promise<void> {
    setBusy(true);
    setResult({ text: "Creating workspace…", kind: "ok" });
    try {
      const res = await bridge.callTool("create-workspace", {
        formData: (formData as Record<string, unknown>) ?? {},
        open,
      });
      const text = String(res?.output ?? "Workspace created.").trim() || "Workspace created.";
      setResult({ text, kind: "ok" });
      setDone(true);
      onCreated(text);
    } catch (err) {
      setResult({ text: `Failed: ${(err as Error).message}`, kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  // Drop the root schema title — the card already has a heading.
  const schema: RJSFSchema = { ...bundle.schema, title: undefined };

  // Route the `issue_id` field through the IssueWidget (adds the Fetch button)
  // client-side, so the shared CLI-provided schema needs no browser-only knob.
  const uiSchema: UiSchema = {
    ...bundle.uiSchema,
    issue_id: { ...(bundle.uiSchema?.issue_id as Record<string, unknown> | undefined), "ui:widget": "issue" },
  };

  const actions = e(
    "div",
    { className: "actions" },
    onCancel
      ? e("button", { type: "button", className: "cancelbtn", disabled: busy, onClick: onCancel }, "Cancel")
      : null,
    e(
      "label",
      { className: "checkrow" },
      e("input", {
        type: "checkbox",
        checked: open,
        disabled: busy || done,
        onChange: (ev: React.ChangeEvent<HTMLInputElement>) => setOpen(ev.target.checked),
      }),
      e("span", null, "Open in VS Code after creating"),
    ),
    e("button", { type: "submit", className: "submit", disabled: busy || done }, busy ? "Creating…" : "Create workspace"),
  );

  return e(
    "div",
    { className: "rjsf" },
    e(
      Form,
      {
        schema,
        uiSchema,
        formData,
        formContext: {
          getFormData: () => formDataRef.current,
          // The issue widget calls this to populate fields from an issue without
          // clobbering anything the user has already filled (see sandbox-core mergeFormData).
          applyIssueData: (data: Record<string, unknown>) =>
            setFormData((prev) => mergeFormData(prev, data)),
        },
        validator,
        widgets: { textarea: TextareaWidget, issue: IssueWidget, checkboxes: GroupedCheckboxesWidget },
        customValidate: validateRepoSelection,
        transformErrors,
        liveValidate: submitAttempted,
        focusOnFirstError: true,
        noHtml5Validate: true,
        disabled: busy || done,
        showErrorList: false,
        onChange: ({ formData }: { formData?: unknown }) => setFormData((formData as Record<string, unknown>) ?? {}),
        onError: () => setSubmitAttempted(true),
        onSubmit,
      },
      actions,
    ),
    result ? e("div", { className: `result ${result.kind}` }, result.text) : null,
  );
}

/**
 * Mount the create-workspace form into `root`. Fetches the RJSF bundle via the
 * bridge, then renders it. `onCreated` fires once a workspace is created (the
 * shell flips to the Workspaces tab and reloads the list).
 */
export function initCreateForm(
  bridge: HostBridge,
  root: HTMLElement,
  opts: { onCreated: (resultText: string) => void; onCancel?: () => void },
): void {
  injectCss("wsform", CSS);

  root.classList.add("wsform");
  root.innerHTML = `
    <div class="card">
      <h1>New workspace</h1>
      <p class="subtitle">Create a sandbox workspace — git worktrees on a <code>&lt;user&gt;/&lt;workspace&gt;</code> branch, then init.</p>
      <div id="wsform-root"><p class="boot">Loading form…</p></div>
    </div>
  `;
  const mount = root.querySelector("#wsform-root") as HTMLElement;

  (async () => {
    try {
      const bundle = (await bridge.callTool("workspace-form-schema")) as FormBundle;
      if (!bundle?.schema) throw new Error("The form schema was empty.");
      createRoot(mount).render(
        e(WorkspaceForm, { bundle, bridge, onCreated: opts.onCreated, onCancel: opts.onCancel }),
      );
    } catch (err) {
      mount.innerHTML = "";
      mount.appendChild(
        Object.assign(document.createElement("p"), {
          className: "err",
          textContent: "Couldn’t load the form: " + (err as Error).message,
        }),
      );
    }
  })();
}
