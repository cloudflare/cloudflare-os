/**
 * The element builder and the icon factory: the two DOM primitives the toolbars, dialogs and
 * status indicators of this library are assembled from.
 */

/**
 * A value an {@link el} prop may take. `null`, `undefined` and `false` mean "no attribute", `true`
 * an empty one; a function under an `on*` key is a listener; an object under `style` is assigned
 * to the element's style.
 */
export type ElPropValue = string | number | boolean | null | undefined | EventListener | Partial<CSSStyleDeclaration>;

/** The props of {@link el}: attribute names to values, plus the `class`, `text`, `html`, `style` and `on*` conveniences. */
export type ElProps = Record<string, ElPropValue>;

/** A child of {@link el}: a node, text (strings and numbers), or nothing (`null`, `undefined`, `false`). */
export type ElChild = Node | string | number | null | undefined | false;

/**
 * Create an element with attributes and children. Attributes are set verbatim, except that `class`
 * sets `className`, `text` sets `textContent`, `html` sets `innerHTML`, `style` given an object is
 * assigned to `element.style`, and an `on*` prop holding a function is added as a listener for the
 * event named after it (`onclick` listens to `click`). Strings and numbers become text nodes; a
 * single child may be passed without an array, and children are appended after `text` or `html`
 * has replaced whatever the element held.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: ElChild | ElChild[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = String(value);
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = String(value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
  }
  return node;
}

/**
 * An inline SVG icon from path markup on a 24-unit grid, stroked in the current colour and sized
 * by the stylesheet (`.icon-btn svg { width: 16px }` and the like). Hidden from assistive
 * technology: the control carrying it names itself.
 */
export function icon(paths: string): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
