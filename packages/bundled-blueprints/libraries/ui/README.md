# `ui` — DOM helpers for document-style gadgets

The Docs, Sheets and Slides blueprints share the same few helpers: an element builder, an SVG icon
factory, toolbar buttons and a dropdown, an in-page prompt (the sandboxed iframe blocks
`window.prompt`), a save-status dot, relative timestamps, and the reading and downscaling of a
pasted image. This library is those helpers once, imported as
`@gadgets/bundled-blueprints/libraries/ui/client`. It is DOM-only: nothing here talks RPC
or touches storage, and nothing here knows what a click means -- every control takes the gadget's
action as an argument.

`@gadgets/bundled-blueprints/libraries/ui/server` exists so that every library has both entries and a
blueprint's server may import any of them uniformly. It exports one flag, `clientOnly`, and nothing
else.

## What it exports

| Export | What it is |
| --- | --- |
| `el(tag, props?, children?)` | Element builder. `class`, `text`, `html`, a `style` object and `on*` listeners are the conveniences; `null`/`undefined`/`false` props are skipped, `true` is an empty attribute; children are nodes, strings, numbers or nothing, singly or in an array. |
| `icon(paths)` | The 24-unit stroked SVG the toolbars draw, `aria-hidden`. |
| `ICONS` | Path markup for the icons at least two gadgets share (undo, redo, bold, italic, underline, strike, textcolor, the three alignments, ul, ol, link, image, clear). A gadget spreads its own over it. |
| `iconBtn(paths, title, onClick, label?)`, `segBtn(paths, title, onClick)` | `button.icon-btn` / `button.seg-btn`, `type=button`, titled and `aria-label`led, mousedown prevented so the editor's selection survives; `label` shows text instead of an icon. |
| `group(prio, items, first?)` | `div.tgroup[.p1/.p2/.p3]` led by a `div.tdiv` divider unless `first`. |
| `colorBtn(paths, title, defaultColor, onChange)` | `div.color-btn`: icon, `span.bar` swatch, native colour input; a pick recolours the bar and calls `onChange(hex)`. |
| `customSelect({className?, title?, options, value, onChange})` | The toolbar dropdown: `button.cselect` plus a `div.cmenu` appended to the body while open; options may carry `style` (docs' font preview), `ex` (sheets' format example) or be `{sep: true}`. A value may be a string or a number, matched and reported as a string. Returns `{el, setValue, getValue}`. |
| `promptInline(message, initial?, placeholder \| options?)` | The dialog: resolves the text on OK/Enter, `null` on Cancel/Escape/backdrop. Options: `placeholder`, `okLabel`. |
| `PROMPT_STYLES` | CSS for the dialog's classes, scoped under `.prompt-overlay`/`.prompt-card`, for a gadget whose stylesheet has none. |
| `statusIndicator({kind?, text?, title?})` | `div.status` > `span.dot.<kind>` + text; `set(kind, text)` is a no-op when nothing changed. |
| `relativeTime(epochMs, now?)` | `just now`, `3 min ago`, `2 h ago`, `5 d ago`, then the locale date. |
| `prepareImage(file, options?)` | Data URL within `maxDimension` (1600px) and `maxDataUrlLength` (1.4M chars): a GIF within `maxGifDataUrlLength` (2.7M chars, about 2 MB) is kept animated, everything else becomes WebP (JPEG where WebP cannot be encoded) at falling quality, then falling size. `alt` defaults to `altFromFileName`. |
| `readFileAsDataURL(file)`, `loadImage(src)` | Its two steps, for a gadget that wants one of them. |
| `isImageFile`, `imageFilesFrom(transfer)`, `IMAGE_TYPES`, `DEFAULT_IMAGE_LIMITS`, `altFromFileName` | The rest of the image module. |

Every element is styled by the gadget's own stylesheet through the class names above; the library
ships no CSS but `PROMPT_STYLES`.

## Behaviour worth knowing

- **`el`** has no `data` prop; write a `data-x` attribute. `text` sets `textContent` before the
  children are appended, so both may be given.
- **`iconBtn`/`segBtn`** prevent mousedown so the editor's selection survives the click;
  **`customSelect`**'s button does not, and a gadget whose selection has to survive it adds that
  listener to the returned element, as Docs does on its colour button. The dropdown's label for a
  value no option carries is the first choice's.
- **`promptInline`**'s message is text, not markup.
- **`prepareImage`** tries four encoding qualities before it shrinks the image, and keeps a GIF
  animated only while its data URL fits `maxGifDataUrlLength`. A gadget with its own conversion
  (Slides passes SVG through, keeps PNG as PNG and falls back to the original on any failure) uses
  `readFileAsDataURL` and `loadImage` and does the rest itself.
- **`relativeTime`** has no caller among the bundled blueprints yet.

## Tests

`__tests__/` covers every export in jsdom (`time.test.ts` in node). jsdom decodes no images and
draws on no canvas, so `images.test.ts` stands in an `Image` that reports the size written in its
source and a canvas whose data URL is as long as the requested quality and pixel count say.
