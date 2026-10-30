// Views the agent's `executeCode` shows with `embedView` (see plans/live-views.md). This module is
// the one place that turns a view into the HTML its frame runs, for the Workshop and the evals.

import type { EmbeddedView } from "./api";

/**
 * The view's HTML, as the body of a `<gadget-ui>` block: its style, its markup, then a module that
 * calls the view's script function with its data. The module goes in as a `data:` URL, so nothing
 * in the script's source or its data can end the script element or add markup. The data goes in
 * as its JSON text in a string, which the module parses, so a key such as `__proto__` stays data
 * rather than being read as JavaScript.
 */
export function embeddedViewHtml(view: EmbeddedView): string {
  const style = view.css === undefined ? "" : `<style>${view.css}</style>\n`;
  if (view.script === undefined) return `${style}${view.html}`;
  const data = view.data === undefined ? "null" : `JSON.parse(${JSON.stringify(view.data)})`;
  const module = `await ${view.script}(${data});`;
  return `${style}${view.html}\n<script type="module" src="data:text/javascript;charset=utf-8,${encodeURIComponent(module)}"></script>`;
}
