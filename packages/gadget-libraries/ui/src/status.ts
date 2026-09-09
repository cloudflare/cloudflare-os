/**
 * The save-status indicator in a gadget's top bar: a coloured dot and a word, both driven by one
 * `set(kind, text)` as the sync layer reports.
 */

import { el } from "./dom.ts";

/** What {@link statusIndicator} starts as. */
export interface StatusOptions {
  /** The initial kind, a class on the dot; `saved` by default. */
  kind?: string;
  /** The initial text; `Saved` by default. */
  text?: string;
  /** A `title` on the indicator, e.g. `Save status`. */
  title?: string;
}

/** A save-status indicator: the element to place, and the one way to change it. */
export interface StatusIndicator {
  /** The `div.status` holding `span.dot.<kind>` and the text. */
  readonly element: HTMLDivElement;
  /**
   * Show a state. `kind` becomes the dot's class beside `dot` -- the gadgets' stylesheets colour
   * `saved`, `saving`, `synced`, `conflict`, `offline` and `bad` -- and `text` the label. A repeat
   * of the current state touches nothing, so this may be called on every event.
   */
  set(kind: string, text: string): void;
}

/** Build a {@link StatusIndicator}. */
export function statusIndicator({ kind = "saved", text = "Saved", title }: StatusOptions = {}): StatusIndicator {
  const dot = el("span", { class: `dot ${kind}` });
  const label = el("span", {}, [text]);
  const element = el("div", { class: "status", title }, [dot, label]);
  let currentKind = kind;
  let currentText = text;
  return {
    element,
    set(nextKind, nextText) {
      if (nextKind === currentKind && nextText === currentText) return;
      currentKind = nextKind;
      currentText = nextText;
      dot.className = `dot ${nextKind}`;
      label.textContent = nextText;
    },
  };
}
