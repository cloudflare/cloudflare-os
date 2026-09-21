import {
  Decoration, EditorView, GutterMarker, WidgetType, gutter, lineNumberMarkers,
  lineNumberWidgetMarker,
} from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
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

// The diff view's renderer: turns a DiffModel (see ./diffModel) into CodeMirror decorations
// and gutter markers for one side of the view.
//
// - Added/deleted lines get whole-line decorations; char-level changes on paired (replacement)
//   lines get mark decorations.
// - Each line's color coding (green add / yellow replacement / red delete) is one GutterMarker
//   class shared by two gutters: a dedicated 3px change-bar gutter and the line-number gutter
//   (which tints and recolors the number).
// - Deleted content renders as block widgets above the modified line it preceded (stacked
//   layout), with the deleted lines' own numbers rendered into the real gutters via the
//   widget-marker hooks, and truncation past MAX_DELETED_ROWS behind an expand button.
// - In the split layout, each side instead gets hatched blank-zone widgets where the other
//   side has more lines, keeping unchanged lines vertically aligned (both editors disable
//   wrapping and share a fixed line height).
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
 * gutter and line-number gutter hooks. Place before `lineNumbers()` in the editor's extension
 * list so the bar gutter renders leftmost.
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
        if (run.originalCount > 0) {
          pushZoneBefore(deco, doc, run.modifiedStart,
            new DeletionZoneWidget(run, expandedDeletions.has(run.key), onExpandDeletion))
        }
      } else if (run.originalCount > run.modifiedCount) {
        pushZoneAfter(deco, doc, run.modifiedStart + run.modifiedCount - 1,
          new BlankZoneWidget(run.originalCount - run.modifiedCount))
      }
    } else {
      pushLineDecorations({ deco, gutterMarks, doc, run, side })
      pushInlineMarks(deco, doc, run, side)
      if (run.modifiedCount > run.originalCount) {
        pushZoneAfter(deco, doc, run.originalStart + run.originalCount - 1,
          new BlankZoneWidget(run.modifiedCount - run.originalCount))
      }
    }
  }

  return {
    deco: Decoration.set(deco, true),
    gutter: RangeSet.of(gutterMarks, true),
  }
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
  if (widget instanceof DeletionZoneWidget) return new DeletionZoneGutterMarker(widget, kind)
  if (widget instanceof BlankZoneWidget) return BLANK_ZONE_MARKER
  return null
}

/** Hatched filler aligning this side with the other side's extra lines (split layout). */
class BlankZoneWidget extends WidgetType {
  constructor(readonly lines: number) {
    super()
  }
  override eq(other: BlankZoneWidget): boolean {
    return other.lines === this.lines
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

/** Everything a deletion zone renders, for cheap widget/marker equality across model rebuilds. */
function zoneSignature(run: ChangeRun, expanded: boolean): string {
  const parts: string[] = [run.key, expanded ? 'x' : '-', String(run.originalStart)]
  for (let i = 0; i < run.originalCount; i++) {
    const lineNumber = run.originalStart + i
    const paired = run.pairedOriginalLines.has(lineNumber)
    parts.push(
      run.deletedText[i] ?? '',
      paired ? 'p' : '-',
      paired ? JSON.stringify(run.inlineOriginalRanges.get(lineNumber) ?? null) : '',
    )
  }
  return parts.join('\u0000')
}

/** A change run's deleted lines, rendered as a block above the modified line they preceded. */
class DeletionZoneWidget extends WidgetType {
  readonly signature: string
  constructor(
    readonly run: ChangeRun,
    readonly expanded: boolean,
    readonly onExpand: (key: string) => void,
  ) {
    super()
    this.signature = zoneSignature(run, expanded)
  }
  override eq(other: DeletionZoneWidget): boolean {
    return other.signature === this.signature
  }
  override get estimatedHeight(): number {
    return Math.max(1, zoneRows(this.run, this.expanded).length) * LINE_HEIGHT_PX
  }
  override toDOM(): HTMLElement {
    const zone = document.createElement('div')
    zone.className = 'gadgets-deleted-code-zone'
    for (const row of zoneRows(this.run, this.expanded)) {
      if (row.kind === 'omitted') {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'gadgets-deleted-code-row gadgets-deleted-omitted-row'
        button.textContent =
          `Show ${row.hidden} hidden deleted line${row.hidden === 1 ? '' : 's'}`
        button.addEventListener('click', () => this.onExpand(this.run.key))
        zone.append(button)
        continue
      }
      const lineNumber = this.run.originalStart + row.index
      const codeRow = document.createElement('div')
      codeRow.className = 'gadgets-deleted-code-row'
      appendDeletedLineContent(
        codeRow,
        this.run.deletedText[row.index] ?? '',
        this.run.pairedOriginalLines.has(lineNumber)
          ? this.run.inlineOriginalRanges.get(lineNumber) ?? []
          : [],
      )
      zone.append(codeRow)
    }
    return zone
  }
}

/**
 * A deletion zone's gutter column: the change bars (`bar`) or the deleted lines' original
 * numbers (`num`), row-aligned with the widget's content.
 */
class DeletionZoneGutterMarker extends GutterMarker {
  constructor(readonly widget: DeletionZoneWidget, readonly kind: 'bar' | 'num') {
    super()
    this.elementClass =
      kind === 'bar' ? 'gadgets-deleted-bar-zone' : 'gadgets-deleted-margin'
  }
  eq(other: GutterMarker): boolean {
    return other instanceof DeletionZoneGutterMarker && other.kind === this.kind &&
      other.widget.signature === this.widget.signature
  }
  override toDOM(): Node {
    const { run, expanded } = this.widget
    const column = document.createElement('div')
    for (const row of zoneRows(run, expanded)) {
      const rowDom = document.createElement('div')
      if (row.kind === 'omitted') {
        rowDom.className = 'gadgets-deleted-num-row gadgets-deleted-omitted-row'
        if (this.kind === 'num') rowDom.textContent = '...'
      } else {
        const lineNumber = run.originalStart + row.index
        const paired = run.pairedOriginalLines.has(lineNumber)
        rowDom.className = paired
          ? 'gadgets-deleted-num-row gadgets-replacement-num-row'
          : 'gadgets-deleted-num-row'
        if (this.kind === 'num' && !paired) rowDom.textContent = String(lineNumber)
      }
      column.append(rowDom)
    }
    return column
  }
}

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
