# `ui` — DOM helpers for document-style gadgets

The Docs, Sheets and Slides blueprints (and the wiki page editor this library was extracted
alongside) each carried their own copy of the same few helpers: an element builder, an SVG icon factory, toolbar buttons and a dropdown, an
in-page prompt (the sandboxed iframe blocks `window.prompt`), a save-status dot, relative
timestamps, and the reading and downscaling of a pasted image. This library is those helpers once,
imported as `gadgets:ui/client`. It is DOM-only: nothing here talks RPC or touches storage, and
nothing here knows what a click means -- every control takes the gadget's action as an argument.

`gadgets:ui/server` exists because the build bundles both sides of every library. It exports one
flag, `clientOnly`, and nothing else.

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

## Where the copies differed

The wiki page editor's TypeScript (its `dom.ts`, `images.ts` and client helpers) was the
reference; the JavaScript blueprints' copies were compared against it and, where two consumers
differed, the difference became a parameter rather than a second function. What a gadget adopting
the library gets that its own copy did not:

- **`el`**: the page's rules -- a `false` prop is skipped (the JavaScript copies wrote `"false"`), a
  `true` prop is an empty attribute, and an `on*` prop is a listener only when it is a function.
  From the JavaScript copies it takes a single child without an array (`el("span", {}, "Saved")`);
  from Slides, numbers as children, `style` as an object, and `text`, which sets `textContent`
  before the children are appended -- Slides passes it in some fifty calls, and an unsupported prop
  would degrade to a `text` attribute rather than an error. Slides' `data` prop
  (`Object.assign(element.dataset, value)`) is not supported: nothing passes one, and a `data-x`
  attribute needs no branch.
- **`icon`**: the page's `aria-hidden="true"`, which the Docs and Sheets copies lacked. Slides draws
  its icons as complete SVGs at other stroke widths and is not covered.
- **`ICONS.image`** is the page's drawing; Docs' has one more path and Sheets has none.
- **`iconBtn`/`segBtn`**: the page's `type="button"` and `aria-label`, which the Docs and Sheets
  buttons lacked; Sheets' text-label variant. The gadget's action moves into the `onClick` it
  passes (Docs' and Sheets' `segBtn`/`colorBtn` had the editor command baked in), and Docs, which
  captured its selection on the colour button's mousedown, adds that listener to the returned
  element.
- **`customSelect`**: the union of Docs (`style` on an option, a no-op `setValue` for the current
  value) and Sheets (`sep` and `ex`). The unknown-value label is the first *choice*'s, as in
  Sheets; with no separators that is Docs' `options[0]`. The button itself does not prevent
  mousedown (Sheets did not; Docs did, and adds its own listener as with the colour button). An
  option's value may be a number, as in Docs' size selector, and is matched against the menu item
  and handed to `onChange` and `getValue` as its string form -- Docs' copy compared the `.sel` item
  by string and the label by identity, which agrees with this wherever the caller is consistent.
- **`promptInline`**: the page's DOM and classes, and the Docs/Sheets `null` on cancel -- the
  `window.prompt` contract the two blueprints already check for (`== null`, `=== null`) -- where the
  page resolved `undefined`. The message is text, not the markup Docs set. Docs' `Insert` button
  and `https://` placeholder are options; Sheets' `overlay`/`dialog`/`msg`/`row` classes and Docs'
  inline styles are replaced by the page's classes plus `PROMPT_STYLES`.
- **`statusIndicator`**: Docs' and Sheets' skip of a repeated state, which the page lacked; the DOM
  is the same three elements all three built by hand.
- **Images**: the page's algorithm. Docs encoded once at 0.86 and kept a GIF under 2 MB unscaled;
  the library tries four qualities and then shrinks, and keeps a GIF by data-URL length, at a
  budget of its own (`maxGifDataUrlLength`) that defaults to Docs' 2 MB. Docs used
  the raw file name as alt; pass `{alt: file.name}` to keep that. Slides passes SVG through, keeps
  PNG as PNG and falls back to the original on any failure; it can use `readFileAsDataURL` and
  `loadImage` and keep its own conversion. The error messages are the page's.
- **`relativeTime`** and **`imageFilesFrom`** came from the page editor's TypeScript; no bundled
  blueprint calls them yet.

## Tests

`__tests__/` covers every export in jsdom (`time.test.ts` in node). jsdom decodes no images and
draws on no canvas, so `images.test.ts` stands in an `Image` that reports the size written in its
source and a canvas whose data URL is as long as the requested quality and pixel count say.
