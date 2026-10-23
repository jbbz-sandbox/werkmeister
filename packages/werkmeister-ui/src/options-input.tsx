/**
 * Generic, reusable "options input" widget — a vertical checklist of selectable
 * actions (the shape the reconcile chat shows after its analysis: Approve /
 * Request changes), with its own CSS, so any surface can drop in
 * `<OptionsInput options onSelect />` and know nothing about its internals.
 *
 * Each option is an independent action: clicking a row runs its `onSelect`
 * (sync or async), shows an inline ✓ / ✗ + message, and stays clickable (so e.g.
 * you can Approve and then open the PR). It does NOT assume a single terminal
 * choice — callers that want radio-style exclusivity can disable in `onSelect`.
 */
import { useState } from "react";
import { Css } from "./style.js";

export interface OptionSpec {
  label: string;
  /** Optional secondary line under the label. */
  description?: string;
}

export interface OptionsInputOpts {
  options: OptionSpec[];
  /** Run the action for the clicked option. Throw to show an error status. */
  onSelect: (index: number, option: OptionSpec) => void | Promise<void>;
  /** Optional heading above the list. */
  title?: string;
}

const CSS = `
  .opt-input { margin-top: 10px; border-top: 1px solid var(--sd-chat-line); padding-top: 10px; }
  .opt-input .opt-title { font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: var(--sd-chat-title); margin: 0 0 8px; }
  .opt-input .opt-row { display: flex; align-items: flex-start; gap: 10px; width: 100%;
    text-align: left; font: inherit; cursor: pointer; padding: 8px 10px; margin: 4px 0;
    background: var(--sd-chat-surface); border: 1px solid var(--sd-chat-ctl); border-radius: 8px; color: var(--sd-chat-ink); }
  .opt-input .opt-row:hover:not(:disabled) { background: var(--sd-chat-line); border-color: var(--sd-chat-ctl-hover); }
  .opt-input .opt-row:disabled { opacity: 0.6; cursor: default; }
  .opt-input .opt-box { flex: none; width: 16px; height: 16px; margin-top: 1px;
    border: 1.5px solid var(--sd-chat-faint); border-radius: 4px; display: inline-flex;
    align-items: center; justify-content: center; font-size: 12px; color: var(--sd-on-accent); }
  .opt-input .opt-row.done .opt-box { background: var(--sd-ok); border-color: var(--sd-ok); }
  .opt-input .opt-row.err .opt-box { background: var(--sd-chat-err-solid); border-color: var(--sd-chat-err-solid); }
  .opt-input .opt-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .opt-input .opt-label { font-size: 13px; font-weight: 600; }
  .opt-input .opt-desc { font-size: 11px; color: var(--sd-chat-desc); }
  .opt-input .opt-status { font-size: 11px; margin-top: 2px; }
  .opt-input .opt-status.ok { color: var(--sd-chat-ok); }
  .opt-input .opt-status.err { color: var(--sd-chat-err); }
`;

export function OptionsInput({ options, onSelect, title }: OptionsInputOpts) {
  return (
    <div className="opt-input">
      <Css id="opt-input" css={CSS} />
      {title && <div className="opt-title">{title}</div>}
      {options.map((option, i) => (
        <OptionRow key={option.label} option={option} run={() => onSelect(i, option)} />
      ))}
    </div>
  );
}

function OptionRow({ option, run }: { option: OptionSpec; run(): void | Promise<void> }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle");
  const [error, setError] = useState("");
  const click = async () => {
    setState("busy");
    setError("");
    try {
      await run();
      setState("done");
    } catch (e) {
      setState("err");
      setError((e as Error).message || "failed");
    }
  };
  return (
    <button
      type="button"
      className={state === "done" || state === "err" ? `opt-row ${state}` : "opt-row"}
      disabled={state === "busy"}
      onClick={() => void click()}
    >
      <span className="opt-box">{{ idle: "", busy: "…", done: "✓", err: "✗" }[state]}</span>
      <div className="opt-main">
        <span className="opt-label">{option.label}</span>
        {option.description && <span className="opt-desc">{option.description}</span>}
        <span className={state === "err" ? "opt-status err" : "opt-status"}>{error}</span>
      </div>
    </button>
  );
}
