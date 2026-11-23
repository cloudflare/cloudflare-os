import {
  BlockType, Decoration, EditorView, GutterMarker, WidgetType, gutter, lineNumberMarkers,
  lineNumberWidgetMarker,
} from '@codemirror/view'
import type { BlockInfo, DecorationSet } from '@codemirror/view'
import { RangeSet, StateEffect, StateField } from '@codemirror/state'
import type { Extension, Range, Text } from '@codemirror/state'
import {
  type ChangeRun,
  type DiffModel,
  type LineSlice,
  type Side,
  DELETED_HEAD_TAIL,
  MAX_DELETED_ROWS,
  MAX_INLINE_DIFF_LINE_LENGTH,
} from './diffModel'
import { diffOverview, type OverviewKind, type OverviewSegment } from './diffOverview'

// The diff view's renderer: turns a DiffModel (see ./diffModel) into CodeMirror decorations
// and gutter markers for one side of the view.
//
// - Added/deleted lines get whole-line decorations; char-level changes on paired (replacement)
//   lines get mark decorations.
// - Each line's color coding (green add / yellow replacement / red delete) is one GutterMarker
//   class shared by two gutters: a dedicated 3px change-bar gutter and the line-number gutter
//   (which tints and recolors the number).
// - Deleted content renders as block widgets above the modified line it preceded (stacked
//   layout), one per deleted line so each wraps and sizes its gutter cells like a real line,
//   with the deleted lines' own numbers rendered into the real gutters via the widget-marker
//   hooks, and truncation past MAX_DELETED_ROWS behind an expand button.
// - In the split layout, each side instead gets hatched blank-zone widgets where the other
//   side has more lines, keeping unchanged lines vertically aligned (both editors disable
//   wrapping and share a fixed line height).
// - The modified side also gets the overview strip (./diffOverview) beside its scrollbar, with
//   marks taken from the same markers and zone widgets. That side is the right-hand pane in the
//   split layout, and its zones stand in for the deleted lines in both layouts.
//
// The host component dispatches `setDiffRender` whenever the model, layout, or expansion state
// changes (rAF-coalesced per keystroke); between dispatches the decorations map through
// document changes, and everything clamps to the current document so a transiently stale model
// never throws.

/** Editor line height in px; matches the code theme's `lineHeight` and the deletion-row CSS. */
const LINE_HEIGHT_PX = 20

export type DiffLayout = 'stacked' | 'split'

export type DiffRenderInput = {
  model: DiffModel
  layout: DiffLayout
  /** Deletion-block keys (ChangeRun.key) the user has expanded past truncation. */
  expandedDeletions: ReadonlySet<string>
  onExpandDeletion: (key: string) => void
}

/** Replaces the diff layer's rendering state (see the module comment). */
export const setDiffRender = StateEffect.define<DiffRenderInput>()

type DiffRenderState = {
  deco: DecorationSet
  gutter: RangeSet<GutterMarker>
}

const EMPTY_STATE: DiffRenderState = { deco: Decoration.none, gutter: RangeSet.empty }

/**
 * The diff layer for one editor: a state field holding the decorations plus the change-bar
 * gutter and line-number gutter hooks, and on the modified side the overview strip. Place
 * before `lineNumbers()` in the editor's extension list so the bar gutter renders leftmost.
 */
export function diffRenderExtension(side: Side): Extension {
  const field = StateField.define<DiffRenderState>({
    create: () => EMPTY_STATE,
    update(value, tr) {
      let next = value
      if (tr.docChanged) {
        next = { deco: next.deco.map(tr.changes), gutter: next.gutter.map(tr.changes) }
      }
      for (const effect of tr.effects) {
        if (effect.is(setDiffRender)) {
          next = buildRenderState(side, effect.value, tr.state.doc)
        }
      }
      return next
    },
    provide: f => EditorView.decorations.from(f, state => state.deco),
  })
  return [
    field,
    gutter({
      class: 'gadgets-diff-gutter-bar',
      markers: view => view.state.field(field).gutter,
      widgetMarker: (_view, widget) => widgetGutterMarker(widget, 'bar'),
    }),
    lineNumberMarkers.compute([field], state => state.field(field).gutter),
    lineNumberWidgetMarker.of((_view, widget) => widgetGutterMarker(widget, 'num')),
    side === 'modified'
      ? diffOverview(
        view => overviewSegments(view, view.state.field(field)),
        update => update.startState.field(field) !== update.state.field(field))
      : [],
  ]
}

function buildRenderState(side: Side, input: DiffRenderInput, doc: Text): DiffRenderState {
  const { model, layout, expandedDeletions, onExpandDeletion } = input
  const deco: Range<Decoration>[] = []
  const gutterMarks: Range<GutterMarker>[] = []

  for (const run of model.changes) {
    if (side === 'modified') {
      pushLineDecorations({ deco, gutterMarks, doc, run, side })
      pushInlineMarks(deco, doc, run, side)
      if (layout === 'stacked') {
        for (const widget of deletionZoneWidgets(
          run, expandedDeletions.has(run.key), onExpandDeletion)) {
          pushZoneBefore(deco, doc, run.modifiedStart, widget)
        }
      } else if (run.originalCount > run.modifiedCount) {
        pushZoneAfter(deco, doc, run.modifiedStart + run.modifiedCount - 1,
          new BlankZoneWidget(run.originalCount - run.modifiedCount, run.modifiedCount > 0))
      }
    } else {
      pushLineDecorations({ deco, gutterMarks, doc, run, side })
      pushInlineMarks(deco, doc, run, side)
      if (run.modifiedCount > run.originalCount) {
        pushZoneAfter(deco, doc, run.originalStart + run.originalCount - 1,
          new BlankZoneWidget(run.modifiedCount - run.originalCount, run.originalCount > 0))
      }
    }
  }

  return {
    deco: Decoration.set(deco, true),
    gutter: RangeSet.of(gutterMarks, true),
  }
}

// ---- overview strip ------------------------------------------------------------------------

function overviewSegments(view: EditorView, render: DiffRenderState): OverviewSegment[] {
  const segments: OverviewSegment[] = []
  render.gutter.between(0, view.state.doc.length, (from, _to, marker) => {
    const kind = marker === ADD_MARKER ? 'add' : marker === MODIFIED_MARKER ? 'modified' : null
    if (kind === null) return
    for (const block of subBlocks(view.lineBlockAt(from))) {
      if (block.type === BlockType.Text) segments.push({ ...blockSpan(block), kind })
    }
  })
  // Zones are block widgets inside their anchor line's block. Read each widget off the block
  // itself (the decoration's instance may have been swapped for an equal one), visiting each
  // anchor once though a deletion zone puts a widget per row there, and deduplicating by
  // position because two zone decorations can share a line block.
  const seenTops = new Set<number>()
  let lastAnchor = -1
  for (const cursor = render.deco.iter(); cursor.value !== null; cursor.next()) {
    if (cursor.from === lastAnchor) continue
    const widget: unknown = cursor.value.spec.widget
    if (zoneOverviewKind(widget) === null) continue
    lastAnchor = cursor.from
    for (const block of subBlocks(view.lineBlockAt(cursor.from))) {
      const kind = zoneOverviewKind(block.widget)
      if (kind === null || seenTops.has(block.top)) continue
      seenTops.add(block.top)
      segments.push({ ...blockSpan(block), kind })
    }
  }
  return segments
}

function blockSpan({ top, bottom, from, to }: BlockInfo) {
  return { top, bottom, from, to }
}

function subBlocks(block: BlockInfo): readonly BlockInfo[] {
  return Array.isArray(block.type) ? block.type : [block]
}

function zoneOverviewKind(widget: unknown): OverviewKind | null {
  if (widget instanceof DeletedLineWidget || widget instanceof OmittedDeletionWidget) {
    return widget.overviewKind
  }
  // A replacement's blank zone matches the yellow of the lines it pads out.
  if (widget instanceof BlankZoneWidget) return widget.replacement ? 'modified' : 'delete'
  return null
}

// ---- line + inline decorations -------------------------------------------------------------

const ADD_LINE = Decoration.line({ class: 'gadgets-diff-line-add' })
const DELETE_LINE = Decoration.line({ class: 'gadgets-diff-line-delete' })
const INLINE_ADD = Decoration.mark({ class: 'gadgets-diff-inline-add' })
const INLINE_DELETE = Decoration.mark({ class: 'gadgets-diff-inline-delete' })

/** A class-only marker shared by the change-bar and line-number gutters. */
class LineClassMarker extends GutterMarker {
  constructor(readonly className: string) {
    super()
    this.elementClass = className
  }
  eq(other: GutterMarker): boolean {
    return other instanceof LineClassMarker && other.className === this.className
  }
}

const ADD_MARKER = new LineClassMarker('gadgets-diff-gutter-add')
const MODIFIED_MARKER = new LineClassMarker('gadgets-diff-gutter-modified')
const DELETE_MARKER = new LineClassMarker('gadgets-diff-gutter-delete')
const DELETE_MODIFIED_MARKER = new LineClassMarker('gadgets-diff-gutter-delete-modified')

function pushLineDecorations({
  deco,
  gutterMarks,
  doc,
  run,
  side,
}: {
  deco: Range<Decoration>[]
  gutterMarks: Range<GutterMarker>[]
  doc: Text
  run: ChangeRun
  side: Side
}) {
  const start = side === 'modified' ? run.modifiedStart : run.originalStart
  const count = side === 'modified' ? run.modifiedCount : run.originalCount
  const paired = side === 'modified' ? run.pairedModifiedLines : run.pairedOriginalLines
  const lineDeco = side === 'modified' ? ADD_LINE : DELETE_LINE
  for (let lineNumber = start; lineNumber < start + count; lineNumber++) {
    if (lineNumber < 1 || lineNumber > doc.lines) continue
    const from = doc.line(lineNumber).from
    deco.push(lineDeco.range(from))
    const marker = side === 'modified'
      ? (paired.has(lineNumber) ? MODIFIED_MARKER : ADD_MARKER)
      : (paired.has(lineNumber) ? DELETE_MODIFIED_MARKER : DELETE_MARKER)
    gutterMarks.push(marker.range(from))
  }
}

function pushInlineMarks(deco: Range<Decoration>[], doc: Text, run: ChangeRun, side: Side) {
  const paired = side === 'modified' ? run.pairedModifiedLines : run.pairedOriginalLines
  const ranges = side === 'modified' ? run.inlineModifiedRanges : run.inlineOriginalRanges
  const mark = side === 'modified' ? INLINE_ADD : INLINE_DELETE
  for (const [lineNumber, slices] of ranges) {
    if (!paired.has(lineNumber)) continue
    if (lineNumber < 1 || lineNumber > doc.lines) continue
    const line = doc.line(lineNumber)
    if (line.length > MAX_INLINE_DIFF_LINE_LENGTH) continue
    for (const slice of slices) {
      const from = line.from + slice.startCol - 1
      const to = Math.min(line.from + slice.endCol - 1, line.to)
      if (from < to) deco.push(mark.range(from, to))
    }
  }
}

// ---- block zones ---------------------------------------------------------------------------

/** Anchor a zone before the given 1-based line (past-the-end anchors after the last line). */
function pushZoneBefore(deco: Range<Decoration>[], doc: Text, lineNumber: number,
                        widget: WidgetType) {
  if (lineNumber <= doc.lines) {
    const from = doc.line(Math.max(1, lineNumber)).from
    deco.push(Decoration.widget({ widget, block: true, side: -10 }).range(from))
  } else {
    deco.push(Decoration.widget({ widget, block: true, side: 10 }).range(doc.length))
  }
}

/** Anchor a zone after the given 1-based line (line 0 anchors before the first line). */
function pushZoneAfter(deco: Range<Decoration>[], doc: Text, lineNumber: number,
                       widget: WidgetType) {
  if (lineNumber <= 0) {
    deco.push(Decoration.widget({ widget, block: true, side: -10 }).range(0))
  } else {
    const to = doc.line(Math.min(lineNumber, doc.lines)).to
    deco.push(Decoration.widget({ widget, block: true, side: 10 }).range(to))
  }
}

function widgetGutterMarker(widget: WidgetType, kind: 'bar' | 'num'): GutterMarker | null {
  if (widget instanceof DeletedLineWidget || widget instanceof OmittedDeletionWidget) {
    return deletedRowGutterMarker(widget, kind)
  }
  if (widget instanceof BlankZoneWidget) return BLANK_ZONE_MARKER
  return null
}

/** Hatched filler aligning this side with the other side's extra lines (split layout). */
class BlankZoneWidget extends WidgetType {
  constructor(
    readonly lines: number,
    /** The zone pads out a replacement (both sides have lines), not a pure add or delete. */
    readonly replacement: boolean,
  ) {
    super()
  }
  override eq(other: BlankZoneWidget): boolean {
    return other.lines === this.lines && other.replacement === this.replacement
  }
  override get estimatedHeight(): number {
    return Math.max(1, this.lines) * LINE_HEIGHT_PX
  }
  override toDOM(): HTMLElement {
    const dom = document.createElement('div')
    dom.className = 'gadgets-diff-blank-zone'
    dom.style.height = `${this.estimatedHeight}px`
    return dom
  }
}

class BlankZoneClassMarker extends GutterMarker {
  constructor() {
    super()
    this.elementClass = 'gadgets-diff-blank-margin'
  }
  eq(other: GutterMarker): boolean {
    return other instanceof BlankZoneClassMarker
  }
}

const BLANK_ZONE_MARKER = new BlankZoneClassMarker()

// ---- deletion zones ------------------------------------------------------------------------
//
// A deletion zone is a run of block widgets, one per deleted line plus one for the truncation
// row, so CodeMirror sizes each row and its gutter cells as it does a real line: a deleted line
// wraps when the editor wraps, and its number stays beside it.

type ZoneRow =
  | { kind: 'line'; index: number }
  /** The truncation row: an expand button in the content area, "..." in the gutter. */
  | { kind: 'omitted'; hidden: number }

function zoneRows(run: ChangeRun, expanded: boolean): ZoneRow[] {
  const total = run.originalCount
  if (expanded || total <= MAX_DELETED_ROWS) {
    return Array.from({ length: total }, (_, index) => ({ kind: 'line', index }))
  }
  const rows: ZoneRow[] = []
  for (let i = 0; i < DELETED_HEAD_TAIL; i++) rows.push({ kind: 'line', index: i })
  rows.push({ kind: 'omitted', hidden: total - 2 * DELETED_HEAD_TAIL })
  for (let i = total - DELETED_HEAD_TAIL; i < total; i++) rows.push({ kind: 'line', index: i })
  return rows
}

/** A zone's widgets, in order. */
function deletionZoneWidgets(
  run: ChangeRun, expanded: boolean, onExpand: (key: string) => void,
): WidgetType[] {
  // A replacement's deleted lines match the yellow of the lines replacing them.
  const overviewKind: OverviewKind = run.modifiedCount > 0 ? 'modified' : 'delete'
  return zoneRows(run, expanded).map(row => {
    if (row.kind === 'omitted') {
      return new OmittedDeletionWidget(run.key, row.hidden, overviewKind, onExpand)
    }
    const lineNumber = run.originalStart + row.index
    const paired = run.pairedOriginalLines.has(lineNumber)
    return new DeletedLineWidget(
      lineNumber,
      run.deletedText[row.index] ?? '',
      paired,
      paired ? run.inlineOriginalRanges.get(lineNumber) ?? [] : [],
      overviewKind,
    )
  })
}

/** One deleted line, drawn above the modified line it preceded. */
class DeletedLineWidget extends WidgetType {
  private readonly slicesKey: string
  constructor(
    readonly lineNumber: number,
    readonly text: string,
    /** Replaced by a modified line (yellow), not purely deleted (red). */
    readonly paired: boolean,
    readonly slices: LineSlice[],
    readonly overviewKind: OverviewKind,
  ) {
    super()
    this.slicesKey = JSON.stringify(slices)
  }
  override eq(other: DeletedLineWidget): boolean {
    return other.lineNumber === this.lineNumber && other.text === this.text &&
      other.paired === this.paired && other.slicesKey === this.slicesKey &&
      other.overviewKind === this.overviewKind
  }
  override get estimatedHeight(): number {
    return LINE_HEIGHT_PX
  }
  override toDOM(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gadgets-deleted-code-row'
    appendDeletedLineContent(row, this.text, this.slices)
    return row
  }
}

/** A truncated zone's middle: a button that expands the zone to all its deleted lines. */
class OmittedDeletionWidget extends WidgetType {
  constructor(
    readonly runKey: string,
    readonly hidden: number,
    readonly overviewKind: OverviewKind,
    readonly onExpand: (key: string) => void,
  ) {
    super()
  }
  override eq(other: OmittedDeletionWidget): boolean {
    return other.runKey === this.runKey && other.hidden === this.hidden &&
      other.overviewKind === this.overviewKind
  }
  override get estimatedHeight(): number {
    return LINE_HEIGHT_PX
  }
  override toDOM(): HTMLElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'gadgets-deleted-code-row gadgets-deleted-omitted-row'
    button.textContent = `Show ${this.hidden} hidden deleted line${this.hidden === 1 ? '' : 's'}`
    button.addEventListener('click', () => this.onExpand(this.runKey))
    return button
  }
}

/** A deletion zone row's gutter cell: a class, plus the deleted line's number or "...". */
class DeletedRowGutterMarker extends GutterMarker {
  constructor(override readonly elementClass: string, readonly label: string) {
    super()
  }
  eq(other: GutterMarker): boolean {
    return other instanceof DeletedRowGutterMarker && other.elementClass === this.elementClass &&
      other.label === this.label
  }
  override toDOM(): Node {
    return document.createTextNode(this.label)
  }
}

function deletedRowGutterMarker(
  widget: DeletedLineWidget | OmittedDeletionWidget, kind: 'bar' | 'num',
): GutterMarker {
  if (widget instanceof OmittedDeletionWidget) {
    return kind === 'bar' ? DELETE_MARKER : OMITTED_NUM_MARKER
  }
  if (kind === 'bar') return widget.paired ? DELETE_MODIFIED_MARKER : DELETE_MARKER
  // A replaced line's number would read as the number of the line replacing it.
  return new DeletedRowGutterMarker(
    'gadgets-deleted-margin', widget.paired ? '' : String(widget.lineNumber))
}

const OMITTED_NUM_MARKER =
  new DeletedRowGutterMarker('gadgets-deleted-margin gadgets-deleted-omitted-row', '...')

function appendDeletedLineContent(row: HTMLElement, text: string, slices: LineSlice[]) {
  if (slices.length === 0 || text.length > MAX_INLINE_DIFF_LINE_LENGTH) {
    row.textContent = text
    return
  }
  const sorted = [...slices].toSorted((a, b) => a.startCol - b.startCol)
  let column = 1
  for (const slice of sorted) {
    const clampedEnd = Math.min(slice.endCol, text.length + 1)
    if (slice.startCol > column) {
      row.append(text.slice(column - 1, slice.startCol - 1))
    }
    if (clampedEnd > slice.startCol) {
      const span = document.createElement('span')
      span.className = 'gadgets-diff-inline-delete'
      span.textContent = text.slice(slice.startCol - 1, clampedEnd - 1)
      row.append(span)
    }
    column = Math.max(column, clampedEnd)
  }
  if (column - 1 < text.length) {
    row.append(text.slice(column - 1))
  }
}
