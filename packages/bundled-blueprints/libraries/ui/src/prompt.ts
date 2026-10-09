/**
 * The in-page prompt. `window.prompt` and `window.alert` are blocked in the sandboxed gadget
 * iframe, so a gadget that needs a line of text -- a link's URL, a sheet's name, an image's alt
 * text -- asks with this dialog instead.
 */

import { el } from "./dom.ts";

/** Options of {@link promptInline}. */
export interface PromptOptions {
  /** Placeholder shown in the empty field, e.g. `https://`. */
  placeholder?: string;
  /** The confirm button's text; `OK` unless the action has a better name (`Insert`). */
  okLabel?: string;
}

/**
 * Ask for one line of text. Builds a `div.prompt-overlay` holding a `div.prompt-card` (the
 * message in a `div.muted`, an `input` seeded with `initial`, and Cancel/OK `button.text-btn`s in a
 * `div.composer-actions`), appends it to the body, focuses and selects the field, and resolves with
 * the field's text on OK or Enter, or with `null` on Cancel, Escape or a mousedown on the backdrop
 * -- the `window.prompt` contract. The third argument may be the placeholder alone, or
 * {@link PromptOptions}. The gadget's stylesheet styles the classes; {@link PROMPT_STYLES} is a
 * ready-made rule set for one that has none.
 */
export function promptInline(message: string, initial = "", options: string | PromptOptions = {}): Promise<string | null> {
  const { placeholder = "", okLabel = "OK" } = typeof options === "string" ? { placeholder: options } : options;
  return new Promise((resolve) => {
    const input = el("input", { value: initial, placeholder });
    const done = (value: string | null) => {
      overlay.remove();
      resolve(value);
    };
    const ok = el("button", { class: "text-btn primary", type: "button", onclick: () => done(input.value) }, [okLabel]);
    const cancel = el("button", { class: "text-btn", type: "button", onclick: () => done(null) }, ["Cancel"]);
    const overlay = el("div", { class: "prompt-overlay", onmousedown: (event: Event) => { if (event.target === overlay) done(null); } }, [
      el("div", { class: "prompt-card" }, [el("div", { class: "muted" }, [message]), input, el("div", { class: "composer-actions" }, [cancel, ok])]),
    ]);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") done(input.value);
      if (event.key === "Escape") done(null);
    });
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/**
 * Styles for the dialog {@link promptInline} builds, scoped to its own classes and drawn with the
 * gadgets' shared theme variables (`--surface`, `--line`, `--line-strong`, `--bg`, `--text`,
 * `--muted`, `--accent`, `--surface-2`). For a gadget whose stylesheet has no rules of its own for
 * `.prompt-overlay` and `.prompt-card`: `document.head.appendChild(el("style", { html: PROMPT_STYLES }))`.
 */
export const PROMPT_STYLES = `
.prompt-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(20,20,25,.35); backdrop-filter: blur(5px); z-index: 1001; }
.prompt-card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; width: min(420px, 90vw); display: flex; flex-direction: column; gap: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
.prompt-card .muted { font-size: 13px; color: var(--muted); }
.prompt-card input { width: 100%; padding: 8px 10px; font: inherit; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg); color: var(--text); outline: none; }
.prompt-card .composer-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
.prompt-card .text-btn { border: 1px solid var(--line); background: var(--surface); color: var(--text); border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px; white-space: nowrap; }
.prompt-card .text-btn:hover { background: var(--surface-2); }
.prompt-card .text-btn.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
`;
