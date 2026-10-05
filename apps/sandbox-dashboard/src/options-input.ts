/**
 * Generic, reusable "options input" widget — a vertical checklist of selectable
 * actions (the shape the reconcile chat shows after its analysis: Approve /
 * Request changes). Dependency-free vanilla DOM with its own injected CSS, so any
 * surface can drop it in with `createOptionsInput({ options, onSelect })` and know
 * nothing about its internals.
 *
 * Each option is an independent action: clicking a row runs its `onSelect`
 * (sync or async), shows an inline ✓ / ✗ + message, and stays clickable (so e.g.
 * you can Approve and then open the PR). It does NOT assume a single terminal
 * choice — callers that want radio-style exclusivity can disable in `onSelect`.
 */
import { injectCss } from "./theme.js";

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
  .opt-input { margin-top: 10px; border-top: 1px solid #3a3a38; padding-top: 10px; }
  .opt-input .opt-title { font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.05em; color: #a0a09a; margin: 0 0 8px; }
  .opt-input .opt-row { display: flex; align-items: flex-start; gap: 10px; width: 100%;
    text-align: left; font: inherit; cursor: pointer; padding: 8px 10px; margin: 4px 0;
    background: #2c2c2a; border: 1px solid #4a4a47; border-radius: 8px; color: #e8e8e3; }
  .opt-input .opt-row:hover:not(:disabled) { background: #3a3a38; border-color: #6a6a66; }
  .opt-input .opt-row:disabled { opacity: 0.6; cursor: default; }
  .opt-input .opt-box { flex: none; width: 16px; height: 16px; margin-top: 1px;
    border: 1.5px solid #7a7a74; border-radius: 4px; display: inline-flex;
    align-items: center; justify-content: center; font-size: 12px; color: #fff; }
  .opt-input .opt-row.done .opt-box { background: var(--sd-ok); border-color: var(--sd-ok); }
  .opt-input .opt-row.err .opt-box { background: #b23b2e; border-color: #b23b2e; }
  .opt-input .opt-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .opt-input .opt-label { font-size: 13px; font-weight: 600; }
  .opt-input .opt-desc { font-size: 11px; color: #9a9a92; }
  .opt-input .opt-status { font-size: 11px; margin-top: 2px; }
  .opt-input .opt-status.ok { color: #7bc99a; }
  .opt-input .opt-status.err { color: #e07a6a; }
`;

export function createOptionsInput(opts: OptionsInputOpts): HTMLElement {
  injectCss("opt-input", CSS);
  const box = document.createElement("div");
  box.className = "opt-input";
  if (opts.title) {
    const h = document.createElement("div");
    h.className = "opt-title";
    h.textContent = opts.title;
    box.appendChild(h);
  }

  opts.options.forEach((option, i) => {
    const row = document.createElement("button");
    row.className = "opt-row";
    row.type = "button";

    const boxEl = document.createElement("span");
    boxEl.className = "opt-box";
    row.appendChild(boxEl);

    const main = document.createElement("div");
    main.className = "opt-main";
    const label = document.createElement("span");
    label.className = "opt-label";
    label.textContent = option.label;
    main.appendChild(label);
    if (option.description) {
      const desc = document.createElement("span");
      desc.className = "opt-desc";
      desc.textContent = option.description;
      main.appendChild(desc);
    }
    const status = document.createElement("span");
    status.className = "opt-status";
    main.appendChild(status);
    row.appendChild(main);

    row.addEventListener("click", async () => {
      row.classList.remove("err");
      status.className = "opt-status";
      status.textContent = "";
      row.disabled = true;
      boxEl.textContent = "…";
      try {
        await opts.onSelect(i, option);
        row.classList.add("done");
        boxEl.textContent = "✓";
      } catch (e) {
        row.classList.add("err");
        boxEl.textContent = "✗";
        status.className = "opt-status err";
        status.textContent = (e as Error).message || "failed";
      } finally {
        row.disabled = false;
      }
    });

    box.appendChild(row);
  });

  return box;
}
