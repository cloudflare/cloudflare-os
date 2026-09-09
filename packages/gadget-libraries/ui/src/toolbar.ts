/**
 * Toolbar controls: the buttons, groups, colour pickers and dropdown the document-style gadgets
 * build their formatting bars from. Each returns a plain element styled by the gadget's own
 * stylesheet through the class names given here (`icon-btn`, `seg-btn`, `tgroup`, `tdiv`,
 * `color-btn`, `cselect`, `cmenu`), and none of them knows what a click means: the gadget passes
 * the action.
 */

import { el, icon } from "./dom.ts";

/** A click handler for a toolbar button. */
export type ClickHandler = (event: MouseEvent) => void;

function toolButton(
  className: string,
  paths: string | null,
  title: string,
  onClick: ClickHandler,
  label?: string,
): HTMLButtonElement {
  const button = el("button", { class: className, type: "button", title, "aria-label": title });
  if (label !== undefined) button.textContent = label;
  else if (paths !== null) button.innerHTML = icon(paths);
  // Keep the selection: a mousedown on a toolbar button must not move focus out of the editor.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", onClick);
  return button;
}

/**
 * A `button.icon-btn` showing the icon drawn from `paths` (an {@link ICONS} entry or a gadget's
 * own), titled and labelled for assistive technology by `title`. With `label`, the button shows
 * that text instead of an icon and `paths` may be `null`. Mousedown is prevented so the editor's
 * selection survives the click.
 */
export function iconBtn(paths: string | null, title: string, onClick: ClickHandler, label?: string): HTMLButtonElement {
  return toolButton("icon-btn", paths, title, onClick, label);
}

/** One button of a segmented control (`button.seg-btn`); otherwise exactly {@link iconBtn}. */
export function segBtn(paths: string, title: string, onClick: ClickHandler): HTMLButtonElement {
  return toolButton("seg-btn", paths, title, onClick);
}

/**
 * A toolbar group (`div.tgroup`) of controls, led by a `div.tdiv` divider unless it is the
 * `first` group. `prio` (`"p1"`, `"p2"`, `"p3"` or `null`) is added as a class for the stylesheet
 * to decide which groups collapse first on a narrow screen; the divider is inside the group so it
 * hides with it.
 */
export function group(prio: string | null, items: Node[], first = false): HTMLDivElement {
  const children: Node[] = first ? [] : [el("div", { class: "tdiv" })];
  children.push(...items);
  return el("div", { class: "tgroup" + (prio ? " " + prio : "") }, children);
}

/**
 * A colour picker (`div.color-btn`): the icon, a `span.bar` swatch showing the current colour and
 * a native `input[type=color]` over them. Every pick recolours the bar and calls `onChange` with
 * the CSS hex colour. Mousedown is prevented, as on {@link iconBtn}; a gadget that has to capture
 * its selection first adds its own `mousedown` listener to the returned element.
 */
export function colorBtn(paths: string, title: string, defaultColor: string, onChange: (color: string) => void): HTMLDivElement {
  const bar = el("span", { class: "bar" });
  bar.style.background = defaultColor;
  const input = el("input", { type: "color", value: defaultColor });
  const button = el("div", { class: "color-btn", title }, [el("span", { html: icon(paths) }), bar, input]);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  input.addEventListener("input", () => {
    bar.style.background = input.value;
    onChange(input.value);
  });
  return button;
}

/**
 * The value a {@link customSelect} choice carries. A selector over numbers (a font size, say) may
 * declare them as numbers; a value is matched, stored and reported as its string form either way.
 */
export type SelectValue = string | number;

/** An entry of {@link customSelect}: a choice, or a separator line between choices. */
export type SelectOption =
  | {
    value: SelectValue;
    label: string;
    /** Inline CSS for the menu item, e.g. `font-family:Georgia;` to preview a font. */
    style?: string;
    /** An example rendered right-aligned after the label (`span.ex`), e.g. `1,000.12` for a number format. */
    ex?: string;
  }
  | { sep: true };

/** What {@link customSelect} takes. */
export interface CustomSelectOptions {
  /** Extra class on the `button.cselect`, for the stylesheet to size it. */
  className?: string;
  title?: string;
  options: SelectOption[];
  /** The initial value. */
  value: SelectValue;
  /** Called with the chosen value, as a string, after a click on a menu item; not on `setValue`. */
  onChange: (value: string) => void;
}

/** A {@link customSelect}: its button and the two accessors the gadget drives it with. */
export interface CustomSelect {
  /** The `button.cselect` to place in the toolbar. The menu is appended to `document.body` while open. */
  el: HTMLButtonElement;
  /** Show `value` as selected (label and `.sel` item) without calling `onChange`. */
  setValue(value: SelectValue): void;
  /** The current value as a string, or `undefined` before one is set. */
  getValue(): string | undefined;
}

const CHEVRON = icon('<polyline points="6 9 12 15 18 9"/>');

/**
 * A dropdown that matches the toolbar rather than the browser's `<select>`: a `button.cselect`
 * showing the current label and a chevron, and a `div.cmenu` of `div.cmenu-item`s (plus
 * `div.cmenu-sep` separators) appended to the body under the button while open. It closes on a
 * choice, a mousedown outside, a scroll anywhere or a resize. A value none of the options carries
 * shows the first choice's label and selects nothing.
 */
export function customSelect({ className, title, options, value, onChange }: CustomSelectOptions): CustomSelect {
  let current: string | undefined;
  const labelSpan = el("span", { class: "cs-label" });
  const button = el("button", { type: "button", class: "cselect " + (className ?? ""), title }, [
    labelSpan,
    el("span", { class: "cs-chev", html: CHEVRON }),
  ]);
  const menu = el("div", { class: "cmenu" });
  const choices = options.filter((option): option is Exclude<SelectOption, { sep: true }> => !("sep" in option));
  const items: HTMLDivElement[] = [];
  for (const option of options) {
    if ("sep" in option) {
      menu.appendChild(el("div", { class: "cmenu-sep" }));
      continue;
    }
    const item = el("div", { class: "cmenu-item", "data-value": option.value }, [
      el("span", {}, option.label),
      option.ex ? el("span", { class: "ex" }, option.ex) : null,
    ]);
    if (option.style) item.style.cssText += option.style;
    item.addEventListener("mousedown", (event) => event.preventDefault());
    item.addEventListener("click", () => {
      closeMenu();
      setValue(option.value);
      onChange(String(option.value));
    });
    menu.appendChild(item);
    items.push(item);
  }
  let open = false;

  function setValue(next: SelectValue): void {
    const key = String(next);
    if (key === current) return;
    current = key;
    const chosen = choices.find((option) => String(option.value) === key) ?? choices[0];
    labelSpan.textContent = chosen ? chosen.label : "";
    for (const item of items) item.classList.toggle("sel", item.dataset.value === key);
  }
  function openMenu(): void {
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.round(rect.left) + "px";
    menu.style.top = Math.round(rect.bottom + 4) + "px";
    menu.style.minWidth = Math.round(rect.width) + "px";
    document.body.appendChild(menu);
    open = true;
    button.classList.add("open");
  }
  function closeMenu(): void {
    menu.remove();
    open = false;
    button.classList.remove("open");
  }
  button.addEventListener("click", () => (open ? closeMenu() : openMenu()));
  document.addEventListener("mousedown", (event) => {
    const target = event.target as Node | null;
    if (open && !menu.contains(target) && !button.contains(target)) closeMenu();
  });
  window.addEventListener("scroll", () => { if (open) closeMenu(); }, true);
  window.addEventListener("resize", () => { if (open) closeMenu(); });

  setValue(value);
  return { el: button, setValue, getValue: () => current };
}
