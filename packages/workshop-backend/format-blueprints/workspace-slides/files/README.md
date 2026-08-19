# Workspace Slides

A composable, multiplayer slide deck builder. The deck itself is data —
slides are arrays of typed blocks — and the editor lets anyone add, remove,
reorder, and edit slides in real time. The visual language (tokens,
components, typography) is shared across every block. Edit mode uses light,
neutral sidebars so the slide canvas remains the visual focus.

## Files

- `server.js` — Durable Object that owns the deck document and broadcasts
  every mutation to connected viewers. The server is a generic store; it
  doesn't know what any component does.
- `client.js` — Design tokens, the component registry, slide renderer,
  block interactions (drag, resize, inline text edit), and the builder
  shell (slide list, inspector, palette, control bar, present mode).

## Slide formats

The deck is built in a clean, **branded corporate style** (an orange accent
palette on white slides) and supports two ready-made slide formats. Both live on the fixed
`1200 × 675` reference canvas and are made entirely of normal editable
blocks, so anything a template drops in can be moved, restyled, or deleted
afterward.

### 1. Title / cover slide (`makeTitleSlide()` in `client.js`)

The orange opening slide.

- Full-bleed orange cover artwork (`background.coverOrange`).
- White brand **logo** (a clean editable wordmark with an optional accent
  dot) at `x 36, y 56`, width `267`.
- **Title** — Inter, white, ~58px, weight 700, at `x 33, y 197`, width
  `687`. Kept in the left portion of the slide, max three lines.
- **Subtitle** — Inter, white, ~17px, weight 600, at `x 36, y 533`, width
  `553`, max two lines. Delete the block if no subtitle is needed.

This is also what the seed deck's first slide and the server's
`newBlankSlide()` produce.

### 2. Basic content slide (`makeContentSlide()` in `client.js`)

The standard white content shell for every non-cover idea.

- Pure white background, no inset surface, no shadow, no border.
- **Eyebrow** (`sectionLabel`) — Ruby `#FF6633`, uppercase, SemiBold, at
  `x 36, y 35`. Optional; delete when not useful. Eyebrows are always Ruby.
- **Headline** (`title`) — black `#000000`, ~28px, weight 600, at
  `x 35, y 76`, width `984`, max two lines, written as an assertion.
- **Logo** — the brand wordmark (the `logo` component in its `dark`
  variant: black wordmark + orange accent dot), at `x 1013, y 40`, sized
  via `scale: 0.62`.
- **Content region** — body starts at `x 36, y 204`. The default narrative
  uses a constrained `760px` reading measure at 19px, weight 400,
  line-height 1.6. The add-slide controls also provide exact-grid
  **2-column** (`x 36/609`, `w 553`) and **4-column**
  (`x 34/328/622/916`, `w 260`) compliant structures.
- **Bottom brand bar** — full-width 12px Ruby → Tangerine → Mango
  gradient (`BOTTOM_BAR_SVG`) at `y 663`, touching the bottom edge.

### Creating slides in either format

- **In the editor:** enter edit mode (**E**). The left panel footer has
  two buttons — **Title** and **Content** — that insert the matching
  template after the current slide. Each calls
  `addSlide(makeTitleSlide())` / `addSlide(makeContentSlide())`.
- **Programmatically (over the `GADGET` binding):** call
  `addSlide(atIndex, slideObject)` with a `{ background, blocks }` object.
  The block/prop shapes in `makeTitleSlide` / `makeContentSlide` are the
  canonical reference for the two styles; the server mints block ids on
  insert.

Brand style tokens worth reusing: Ruby `#FF6633`, Tangerine `#F6821F`,
Mango `#FBAD41`, black `#000000`, muted gray `#747474`, Inter throughout.
Slide-facing component controls are intentionally limited to this palette
and the approved 400/500/600/700 weights. Cards and diagram boxes default
to flat white surfaces, thin `#E5E5E5` rules, minimal corner radii, and no
shadows. Generic colored tones and the pill component are not offered in
the component library. The `bulletList` component implements the corporate
hanging-indent treatment: one item per source line, 6px Tangerine dots,
12px dot-to-copy gap, 19px primary or 17px compact Inter Regular text, and
controlled 10px/8px item spacing.

## Data model## Initial blueprint

New Gadget instances start from the current four-slide overview of the
builder: the orange “Compose your deck or build with agent” cover, a six-part
feature overview, a connected-charts example showing how an agent can use an
approved internal system of record as a data source, and a two-path get-started
slide for editing directly or asking the agent. The complete blueprint
is defined by `INITIAL_DECK` plus `KEY_TAKEAWAYS_SLIDE` in `server.js`; both
first-time initialization and `resetAll()` clone that blueprint. The immutable default
objects in `server.js` are cloned whenever storage is first seeded and by
`resetAll()`, so later edits cannot mutate the blueprint.

## Data model

The deck is one JSON document:

```js
{
  slides: [
    {
      id: "abcd1234",
      background: { color: "#f5f1eb", inset: true, dotGrid: 0.45 },
      blocks: [
        { id: "...", type: "title", x: 48, y: 78, w: 1040,
          props: { text: "Hello", fontSize: 46, highlight: "Hello" } },
        ...
      ],
    },
    ...
  ],
}
```

Every block is `{ id, type, x, y, w?, h?, props }`. Position is in the
fixed `1200 × 675` slide coordinate system; the stage scales uniformly to
fit the viewport.

## Component registry

`COMPONENTS` in `client.js` is the catalog. Each entry declares:

| field            | purpose                                                 |
| ---------------- | ------------------------------------------------------- |
| `name`           | Display name (palette + inspector header).              |
| `defaultBlock()` | Returns `{ x, y, w?, h?, props }` for a freshly added block. |
| `fields`         | Inspector schema (`text`, `multiline`, `number`, `select`, `checkbox`, `color`, `image`, `svg`). Set `advanced: true` on a field to tuck it under the inspector's "Advanced" disclosure (along with position/size). |
| `resizableW/H`   | Whether the corner handle adjusts that dimension.       |
| `fullBleed`      | If true (arrow), the block ignores wrapper position and renders an absolutely-positioned overlay. |
| `render(props, ctx)` | Returns the DOM. `ctx.inlineText(elem, propKey, transform?)` wires up contentEditable in edit mode. |

Components exposed in the palette (generic, reusable):

`title`, `subtitle`, `text`, `sectionLabel`, `card`, `box`, `tonePill`,
`image`, `svg`, `divider`, `shape`, `arrow`.

Components defined in `COMPONENTS` but intentionally **not** in the
palette — they're brand marks used by the seed deck only:

`gadgetsMark`, `logo`. The `logo` component renders a clean editable
wordmark (`text` prop, default `Workspace`) with an optional orange accent
dot (`accentDot` prop); change the wordmark to rebrand the deck. They still
render anywhere a block of that type appears; they just aren't offered as
building blocks.

### Adding a new component

1. Add a new entry to `COMPONENTS` with a `render`, `defaultBlock`, and
   `fields`. Use `ctx.inlineText(elem, "propKey")` for any text the user
   should be able to edit directly in the slide.
2. Add the type to `PALETTE_ORDER` so it shows up in the library.
3. Add the type to one of the `COMPONENT_CATEGORIES` groups, and add a
   short description to `COMP_DESC` plus a 14×14 currentColor SVG icon
   to `COMP_ICON`. (The library renders the icon + name + description as
   one row per component.)

That's it — no other code needs to change. The inspector is auto-generated
from `fields`, drag/resize/selection all work automatically.

## Editing

Press **E** (or click the pencil) to enter edit mode. Edit mode reveals:

- **Left panel** — a light, neutral sidebar with a **slide search** (matches
  any string value in any block's props), a scrollable thumbnail list,
  and a split **Add slide** control. The main action inserts the standard
  narrative slide; its caret menu offers title, narrative, 2-column, and
  4-column layouts (see "Slide formats" above). Each row
  shows its slide
  number, the thumbnail, and a one-line label derived from the slide's
  first title (or subtitle / text). Click to jump, drag to reorder
  (disabled while filtering), hover to reveal duplicate/delete. Press
  Enter in the search box to jump to the first match; Escape clears.
- **Right panel** — three stacked sections, in order:
  1. **Component library** — a contained, filterable card. The search
     input doubles as the section title; type to filter (matches on
     name, description, and type id), Enter inserts the first match,
     Escape clears. Without a query, components are grouped by category
     (Text / Containers / Decoration / Diagram); with a query, results
     are flat. The list has its own internal scroll so the library
     never grows past ~280px tall.
  2. **Slide** — compact background settings for the current slide
     (page color, dot grid opacity, inset toggle).
  3. **Selected block inspector** — icon + name header, schema fields
     (label-on-the-left rows, multiline + color stack vertically),
     a 4-button icon row (duplicate, bring forward, send backward,
     delete), and an "Advanced" disclosure that holds position/size
     and any fields tagged `advanced: true`. When nothing is selected
     this is replaced by a quiet "Nothing selected" hint.
- **Stage** — every block is selectable (hover dashes, click to select);
  drag the body to move, the bottom-right handle to resize. Text inside a
  block is contentEditable; press Enter or click away to save. While
  dragging, the block softly snaps when its left / right / center edges
  line up with another block's edges or center, or with the slide bounds
  / center; a thin orange guide line shows which alignment is locked.
  Hold **Alt / Option** while dragging to disable snapping entirely.

Press **F** to enter presentation mode (chrome hidden, stage fills the
viewport, no rounded corners). **Esc** or **F** exits.

## Realtime

Every mutation is sent through RPC to the Durable Object and re-broadcast
as a full deck snapshot via the subscriber callback. The callback signature
is `deckChanged(deck, meta)` where `meta = { canUndo, canRedo }` reflects
the current server-side history state. The client preserves the currently-
selected slide & block across updates when possible.

## Undo / redo

The undo stack lives on the server (in `Gadget`, in memory only — lost on
DO restart, capped at `MAX_UNDO` entries). It's **global**: there's one
shared history for the deck, and pressing undo rolls back the most recent
mutation made by any connected client. Every call to `#save` snapshots
the previous deck onto the undo stack and clears the redo stack;
`undo()` / `redo()` bypass `#save` (so they don't recurse) and broadcast
the restored deck through `#broadcast`. Clients learn whether undo/redo
are currently available from the `meta` arg piggy-backed on every
broadcast, plus an initial `getUndoState()` call at boot.

## Keyboard

- `←` / `→` / `Space` / `PageUp` / `PageDown` — navigate slides
- `Home` / `End` — first / last slide
- `E` — toggle edit mode
- `F` — toggle present mode
- `Delete` / `Backspace` (edit mode) — delete the selected block
- `Ctrl/Cmd + C` / `X` / `V` (edit mode) — copy / cut / paste the selected
  block. The clipboard is in-memory (per tab); paste inserts onto the
  *current* slide with a small position offset so the new block doesn't
  sit perfectly on top of its source, and the new block becomes selected.
- `Ctrl/Cmd + D` (edit mode) — duplicate the selected block in place
  (same as the inspector's duplicate icon, doesn't touch the clipboard).
- `Ctrl/Cmd + Z` — undo; `Ctrl/Cmd + Shift + Z` (or `Ctrl + Y`) — redo.
  Also available as two icon buttons in the floating control bar (only
  shown while in edit mode; the keyboard shortcuts work anywhere).
- `Esc` — close jump menu, then deselect, then exit present mode

## Motion

All UI motion uses a single `--ease` token
(`cubic-bezier(0.23, 1, 0.32, 1)` — a strong ease-out) and a small
`--ease-in-out`. Press feedback on buttons is handled with two CSS
selectors registered in `mountShell`:

- `[data-press]:active { transform: scale(0.97); }` — generic buttons.
- `[data-icon-btn]:active { transform: scale(0.92); }` — pill icon
  buttons in the control bar.

Add either attribute to a button to get the right press feel for free.
Avoid `transition: all`; always specify the exact properties so unrelated
property changes don't accidentally animate.

## Inspector form controls

All inspector inputs (text, number, select, textarea, checkbox, color)
share a small set of CSS classes defined in `mountShell`:

- `.field-input` — the base look (subtle dark fill, transparent border,
  orange ring on focus). Applied to `<input>`, `<select>` and
  `<textarea>`.
- `.field-textarea` — adds the multiline sizing on top of `.field-input`.
- `.field-select` — adds an inline SVG chevron and resets the native
  `appearance` so the select matches text inputs.
- `.field-check` — a custom-painted checkbox (orange when checked).

`fieldRow(label, control, { stacked })` lays out a label + control as a
two-column grid by default; pass `{ stacked: true }` for full-width
controls (multiline only). All field factories (`textField`,
`numberField`, etc.) use this and the classes above, so you almost never
need to touch styles when adding a new field type.

## Notes

- The brand logo and gadgets mark are inlined as SVG; they live in
  the `logo` / `gadgetsMark` components and are used only by the seed
  deck. The palette doesn't expose them as reusable blocks. To rebrand,
  edit the `logo` block's `Wordmark` field (and toggle its accent dot).
- **Image** blocks store their data inside `props.src` as either an
  external URL (loaded normally by `<img>` — note this is one of the few
  network paths the sandbox still allows) or as an inlined `data:` URI.
  Uploads are read via `FileReader`, and raster images larger than
  `MAX_IMAGE_DIM` (1600px on the longest side) are downscaled on canvas
  before being inlined, so the deck JSON doesn't balloon. SVG files are
  passed through verbatim. The custom `image` field type in
  `renderField` renders the preview + upload/clear buttons + URL input.
- **SVG** blocks store raw markup in `props.markup`. `render()` parses
  it with the DOM parser, strips `<script>` elements and `on*` attributes,
  then forces `width="100%" height="100%"` and a `preserveAspectRatio`
  derived from the `fit` prop so the SVG scales to the block bounds.
  Agents can author / replace SVG blocks programmatically over the
  `GADGET` binding: call `addBlock(slideId, { type: "svg", x, y, w, h,
  props: { markup: "<svg ...>...</svg>" } })` or `updateBlock(...,
  { props: { markup: "..." } })`.
- Arrows are special-cased: they render a full 1200×675 SVG overlay and
  store endpoints in `props.x1/y1/x2/y2`. Endpoint handles appear when an
  arrow is selected. **Important**: full-bleed blocks must NOT make their
  root element pointer-clickable, or they'll eat clicks for everything
  rendered before them on the slide. `renderBlock` keeps the SVG itself
  `pointer-events: none` and adds an invisible thick hit-line on top of
  the visible arrow stroke so clicking near the line still selects it.
- Alignment snaps while dragging are implemented in `attachBlockInteractions`
  via three helpers: `computeSnapTargets` (gathers x/y edges + centers from
  every other non-arrow block on the slide, plus slide bounds + center),
  `applySnap` (independently snaps each axis to the nearest target within
  `SNAP_THRESHOLD` slide-units), and `drawSnapGuides` (renders thin orange
  guide lines into a `[data-snap-layer]` div inside the slide frame). The
  snap layer is torn down on `pointerup`. Blocks without explicit `w`/`h`
  (titles, pills, etc.) are measured via `offsetWidth/Height` so their
  rendered bounding box still participates correctly.
- Slide thumbnails in the left panel are produced by `renderSlideThumbnail`,
  which calls the normal `renderSlide` with `editMode` temporarily forced
  off and wraps the resulting 1200×675 frame in an `overflow:hidden`
  container scaled with `transform: scale(width / 1200)`.
- The slide search at the top of the left panel is built once at shell
  mount (`buildSlideSearchHeader`) and persists across re-renders, so
  typing into it never steals focus. `renderSlideList` reads
  `slideSearch` and walks `filteredSlideIndices()` to decide what to
  show. Drag-to-reorder is disabled when a filter is active since the
  visible positions don't map 1:1 to absolute deck indices.
- Reordering uses native HTML5 drag-and-drop (`draggable="true"` +
  `dragstart`/`dragover`/`drop`). A floating 2px orange line shows the
  drop position; the actual move is done optimistically on the client and
  then sent to the server via `gadget.moveSlide`.
- The sandbox prohibits modal dialogs and external fetches; all asset
  data must be inlined.
- The server still has a `resetAll` RPC method — it's no longer exposed
  in the UI but remains for use from the `GADGET` binding if you ever
  need to nuke the deck.

## Export formats

The deck supports **HTML** and **PDF** exports. Both use the same print renderer, which emits every
slide at its fixed 1200 x 675 aspect ratio without the editor sidebars or presentation controls.
