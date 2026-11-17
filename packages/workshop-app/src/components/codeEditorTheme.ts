import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// Everything here is drawn in the app's own tokens (`theme.css`), each a light and a dark pair, so
// the editor follows the app's theme with nothing to switch, and reads as part of the page around
// it: the card's white, the text's black, the subtle grey, and the brand's orange where something
// is chosen.

const BRAND = 'var(--color-kumo-brand)'
const brand = (amount: number) => `color-mix(in oklch, ${BRAND} ${amount}%, transparent)`
const contrast = (amount: number) => `color-mix(in oklch, var(--color-kumo-contrast) ${amount}%, transparent)`

/** The face code is set in: the system's own monospace, which is the one its readers know. */
export const CODE_FONT = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

// A caret, as the fold gutter's markers: the app's own, drawn as Phosphor draws its CaretDown.
const caret = (rotate: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'><path transform='rotate(${rotate} 128 128)' d='M213.66 101.66l-80 80a8 8 0 0 1-11.32 0l-80-80a8 8 0 0 1 11.32-11.32L128 164.69l74.34-74.35a8 8 0 0 1 11.32 11.32Z'/></svg>`)}")`

/**
 * The editor's frame: the card's surface, a gutter of quiet line numbers that brightens the one the
 * caret is on, a caret and selection in the brand's orange, and the find bar floating at the top end
 * over the code, as a pill of the app's own. A diff's lines are tinted as a highlighter would mark
 * paper, and what is left out between its changes is a line across with how much, to open.
 */
const frame = EditorView.theme({
  '&': {
    height: '100%',
    color: 'var(--color-kumo-default)',
    backgroundColor: 'var(--color-kumo-base)',
    fontSize: '13px',
    // The panels floated over it are sized by it (`cqw`).
    containerType: 'inline-size',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: CODE_FONT,
    lineHeight: '20px',
    // The code ends a little before the pane does, so that its last line is not against the edge.
    paddingBottom: '25vh',
    fontVariantLigatures: 'none',
  },
  '.cm-content': { padding: '12px 0', caretColor: BRAND },
  '.cm-line': { padding: '0 24px 0 4px' },

  // The gutter belongs to the code, on the same surface, with nothing between them but room.
  '.cm-gutters': {
    backgroundColor: 'var(--color-kumo-base)',
    color: contrast(28),
    border: 'none',
    fontVariantNumeric: 'tabular-nums',
    userSelect: 'none',
  },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '40px', padding: '0 8px 0 16px', cursor: 'pointer' },
  '.cm-lineNumbers .cm-gutterElement:hover': { color: contrast(60) },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-kumo-default)' },
  // The line the caret is on, only while the code has focus: reading, nothing is singled out.
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: contrast(2.5) },

  // Folding: a caret beside a block that can be folded, shown when the gutter is pointed at.
  '.cm-foldGutter .cm-gutterElement': { width: '16px', display: 'grid', placeItems: 'center', cursor: 'pointer' },
  '.cm-fold-marker': {
    display: 'block',
    width: '10px',
    height: '10px',
    backgroundColor: contrast(45),
    maskSize: '10px',
    maskRepeat: 'no-repeat',
    maskPosition: 'center',
    opacity: '0',
    transition: 'opacity 120ms',
  },
  '.cm-fold-marker[data-open=true]': { maskImage: caret(0) },
  '.cm-fold-marker[data-open=false]': { maskImage: caret(-90), opacity: '1' },
  '.cm-gutters:hover .cm-fold-marker': { opacity: '1' },
  '.cm-foldPlaceholder': {
    margin: '0 4px',
    padding: '0 6px',
    border: 'none',
    borderRadius: '999px',
    backgroundColor: contrast(6),
    color: 'var(--color-kumo-subtle)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  },

  // The caret and what is chosen: the brand's orange, as everything chosen in the app is.
  '.cm-cursor, .cm-dropCursor': { borderLeft: `2px solid ${BRAND}`, marginLeft: '-1px' },
  '.cm-selectionBackground': { backgroundColor: `${brand(12)} !important` },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: `${brand(20)} !important` },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: contrast(7), borderRadius: '3px' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'transparent',
    color: 'inherit',
    outline: `1px solid ${contrast(30)}`,
    borderRadius: '2px',
  },
  '.cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: 'transparent', color: 'var(--color-kumo-danger)' },
  // Lines picked from the gutter, as a link to them names: a band down the line, not a selection.
  '.cm-picked-line': { backgroundColor: brand(8), boxShadow: `inset 2px 0 ${BRAND}` },

  // Found text: each match marked, the current one strongly, as a highlighter would.
  '.cm-searchMatch': { backgroundColor: brand(18), borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: brand(40), boxShadow: `0 0 0 1px ${brand(70)}` },

  // The panels (find, go to line) float over the code at its top end rather than pushing it down.
  '.cm-panels': { backgroundColor: 'transparent', color: 'inherit', border: 'none' },
  '.cm-panels.cm-panels-top': {
    position: 'absolute',
    top: '10px',
    insetInlineEnd: '12px',
    insetInlineStart: 'auto',
    left: 'auto',
    border: 'none',
    zIndex: '20',
  },

  // A diff (`@codemirror/merge`): a line added or taken away tinted across, its changed words more
  // strongly, and a bar in the gutter of the same colour. Marked important, as the merge view's own
  // colours are set for its light and dark classes, which outrank a theme's.
  '.cm-changedLine, .cm-insertedLine, .cm-inlineChangedLine': { backgroundColor: 'var(--color-code-added) !important' },
  '.cm-changedText, ins.cm-insertedText': { background: 'var(--color-code-added-text) !important', textDecoration: 'none', borderRadius: '2px' },
  // A line added whole is all change: its words are not marked again over its tint.
  '.cm-insertedLine .cm-changedText': { background: 'transparent !important' },
  '.cm-deletedChunk': { backgroundColor: 'var(--color-code-removed) !important', paddingLeft: '4px !important' },
  '.cm-deletedChunk .cm-deletedText, del.cm-deletedText, .cm-deletedText': { background: 'var(--color-code-removed-text) !important', textDecoration: 'none', borderRadius: '2px' },
  '.cm-deletedLine, .cm-deletedLine del, .cm-insertedLine': { textDecoration: 'none' },
  '.cm-changeGutter': { width: '3px !important', paddingLeft: '0 !important', marginInlineEnd: '2px' },
  '.cm-changedLineGutter, .cm-insertedLineGutter, .cm-inlineChangedLineGutter': { background: 'var(--color-code-added-mark) !important', borderRadius: '2px' },
  '.cm-deletedLineGutter': { background: 'var(--color-code-removed-mark) !important', borderRadius: '2px' },
  // In a split diff the left side is what was, so what changed there was taken away.
  '&.cm-merge-a .cm-changedLine': { backgroundColor: 'var(--color-code-removed) !important' },
  '&.cm-merge-a .cm-changedText': { background: 'var(--color-code-removed-text) !important' },
  '&.cm-merge-a .cm-changedLineGutter': { background: 'var(--color-code-removed-mark) !important' },
  // What is left out between changes: a soft band across, with how many lines, to open.
  '.cm-collapsedLines': {
    margin: '6px 0',
    // From the start of the line, as what it stands for would be: the band can run far past the
    // view, under lines too long for it, where centred words would be out of sight.
    padding: '0 12px !important',
    height: '28px',
    lineHeight: '28px',
    background: `${contrast(3)} !important`,
    color: 'var(--color-kumo-subtle) !important',
    fontFamily: 'system-ui, sans-serif',
    fontSize: '12px',
    textAlign: 'start',
    cursor: 'pointer',
    transition: 'background-color 120ms, color 120ms',
  },
  '.cm-collapsedLines:before, .cm-collapsedLines:after': { content: '"" !important', margin: '0 !important' },
  '.cm-collapsedLines:hover': { background: `${contrast(6)} !important`, color: 'var(--color-kumo-default) !important' },
  '.cm-mergeSpacer': { backgroundImage: `repeating-linear-gradient(-45deg, transparent 0 5px, ${contrast(5)} 5px 6px)` },
  '.cm-mergeView': { height: '100%' },
  '.cm-mergeViewEditor + .cm-mergeViewEditor': { borderInlineStart: '1px solid var(--color-kumo-line)' },

  // Guides down from each step of indentation, so that a block's shape shows how deep it goes.
  '.cm-indent-guides': {
    backgroundImage: `repeating-linear-gradient(to right, ${contrast(8)} 0 1px, transparent 1px var(--indent-unit))`,
    backgroundSize: 'var(--indent-width) 100%',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: '4px 0',
  },
})

// What tells code apart, in the app's few code colours (`--color-code-*`): mostly the text colour,
// so that a file reads as writing, with words of the language in the brand's warm orange.
const highlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--color-code-comment)', fontStyle: 'italic' },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier, t.self, t.tagName], color: 'var(--color-code-keyword)' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.regexp, t.inserted], color: 'var(--color-code-string)' },
  { tag: [t.escape], color: 'var(--color-code-number)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.variableName)], color: 'var(--color-code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.typeName, t.namespace, t.labelName, t.macroName], color: 'var(--color-code-name)' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], color: 'var(--color-code-property)' },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace, t.squareBracket, t.angleBracket, t.operator, t.derefOperator], color: 'var(--color-code-punctuation)' },
  { tag: t.meta, color: 'var(--color-code-comment)' },
  { tag: t.invalid, color: 'var(--color-kumo-danger)' },
  { tag: t.deleted, color: 'var(--color-kumo-danger)' },
  // Markdown, which a gadget's README is written in: its headings and emphasis as they would look.
  { tag: t.heading, fontWeight: '600', color: 'var(--color-kumo-default)' },
  { tag: t.heading1, fontWeight: '700' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--color-code-name)', textDecoration: 'underline', textUnderlineOffset: '2px' },
  { tag: t.monospace, color: 'var(--color-code-keyword)' },
  { tag: t.quote, color: 'var(--color-kumo-subtle)', fontStyle: 'italic' },
  { tag: t.contentSeparator, color: 'var(--color-code-comment)' },
])

/** The editor's look: its frame and its highlighting, in the app's tokens. */
export const codeEditorTheme = [frame, syntaxHighlighting(highlight)]
