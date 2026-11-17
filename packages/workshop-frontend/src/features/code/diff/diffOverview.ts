import { ViewPlugin } from '@codemirror/view'
import type { EditorView, PluginValue, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

// The diff view's overview strip: a narrow column beside the vertical scrollbar marking where
// the changes are in the whole document, scaled to the strip's height, so changes in a long file
// can be found at a glance. Pressing a mark scrolls to its change; pressing the strip between
// marks scrolls to the spot pressed.
//
// Marks are placed from the editor's own height map rather than line numbers, so block widgets
// (deletion zones, split-layout blank zones) take the space they take on screen. Jumps, though,
// go by document position and re-measure: offscreen heights are estimates (wrapped lines at phone
// widths) until CodeMirror draws them.

export type OverviewKind = 'add' | 'modified' | 'delete'

/**
 * A span to mark: `top`/`bottom` in document-relative px (the coordinates of
 * `EditorView.lineBlockAt`) for drawing, `from`/`to` the document range to jump to.
 */
export type OverviewSegment = {
  top: number
  bottom: number
  from: number
  to: number
  kind: OverviewKind
}

type Measurement = {
  segments: OverviewSegment[]
  /** Scroll-space y of the document's top (the content padding above the first line). */
  docOffset: number
  scrollHeight: number
  clientHeight: number
  scrollbarWidth: number
  /** From the editor's bottom to the scroller's visible bottom: scrollbar plus bottom panels. */
  bottomInset: number
}

/** Drawn height of the shortest mark, so a one-line change stays visible in a long file. */
const MIN_MARK_PX = 2

/**
 * An overview strip for `view`, marking the spans `segments` returns. The strip re-measures on
 * document and layout changes, and whenever `needsUpdate` reports that the spans changed.
 */
export function diffOverview(
  segments: (view: EditorView) => OverviewSegment[],
  needsUpdate: (update: ViewUpdate) => boolean,
): Extension {
  return ViewPlugin.define(view => new DiffOverview(view, segments, needsUpdate))
}

class DiffOverview implements PluginValue {
  private readonly dom: HTMLElement
  /** Each mark's document range. */
  private readonly markRanges = new WeakMap<Element, { from: number; to: number }>()
  // Opening a panel (Find) shrinks the scroller without a geometry or height change in any
  // ViewUpdate, so watch its size directly.
  private readonly resizeObserver = new ResizeObserver(() => this.scheduleMeasure())

  constructor(
    private readonly view: EditorView,
    private readonly segments: (view: EditorView) => OverviewSegment[],
    private readonly needsUpdate: (update: ViewUpdate) => boolean,
  ) {
    this.dom = document.createElement('div')
    this.dom.className = 'gadgets-diff-overview'
    this.dom.hidden = true
    // A pointer shortcut duplicating the scrollbar; keyboard users scroll the editor itself.
    this.dom.setAttribute('aria-hidden', 'true')
    this.dom.addEventListener('mousedown', this.onMouseDown)
    this.dom.addEventListener('wheel', this.onWheel, { passive: false })
    view.dom.append(this.dom)
    this.resizeObserver.observe(view.scrollDOM)
    this.scheduleMeasure()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged || update.heightChanged ||
      this.needsUpdate(update)) {
      this.scheduleMeasure()
    }
  }

  destroy() {
    this.resizeObserver.disconnect()
    this.dom.remove()
  }

  private scheduleMeasure() {
    this.view.requestMeasure({
      key: this,
      read: view => this.read(view),
      write: measurement => this.write(measurement),
    })
  }

  private read(view: EditorView): Measurement {
    const scroller = view.scrollDOM
    return {
      segments: this.segments(view),
      docOffset: view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollbarWidth: scroller.offsetWidth - scroller.clientWidth,
      // The strip lives in `view.dom`, which also holds the panels (the Find panel sits under
      // the scroller), so clear everything below the scroller's visible area.
      bottomInset: view.dom.clientHeight - (scroller.offsetTop + scroller.clientHeight),
    }
  }

  private write(m: Measurement) {
    // Nothing to find when the whole document is already on screen.
    this.dom.hidden = m.segments.length === 0 || m.scrollHeight <= m.clientHeight
    if (this.dom.hidden) return
    this.dom.style.right = `${m.scrollbarWidth}px`
    this.dom.style.bottom = `${m.bottomInset}px`
    // Percentages scale with the strip's height without measuring it. The top is capped so a
    // minimum-height mark for the last line stays inside the strip rather than clipped below.
    const percent = (y: number) => `${(y / m.scrollHeight) * 100}%`
    this.dom.replaceChildren(...mergeSegments(m.segments).map(segment => {
      const top = m.docOffset + segment.top
      const bottom = m.docOffset + segment.bottom
      const mark = document.createElement('div')
      mark.className = `gadgets-diff-overview-mark gadgets-diff-overview-${segment.kind}`
      mark.style.top = `min(${percent(top)}, calc(100% - ${MIN_MARK_PX}px))`
      mark.style.height = percent(bottom - top)
      mark.style.minHeight = `${MIN_MARK_PX}px`
      this.markRanges.set(mark, { from: segment.from, to: segment.to })
      return mark
    }))
  }

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    // Keep the editor's focus and selection where they are.
    event.preventDefault()
    // A mark can be drawn taller than its change (the min-height), so the press point doesn't
    // map back onto a change, and nearby changes' marks overlap. Go to every change under the
    // pointer together.
    let from = Infinity
    let to = -Infinity
    for (const element of this.view.root.elementsFromPoint(event.clientX, event.clientY)) {
      const range = this.markRanges.get(element)
      if (range) {
        from = Math.min(from, range.from)
        to = Math.max(to, range.to)
      }
    }
    if (from <= to) {
      this.jumpTo(from, to)
      return
    }
    const scroller = this.view.scrollDOM
    const rect = this.dom.getBoundingClientRect()
    if (rect.height === 0) return
    const fraction = (event.clientY - rect.top) / rect.height
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2
  }

  /**
   * Scrolls the document range [from, to] into view: centered when it fits, else its start at the
   * top. Each pass scrolls to the target as currently measured; once CodeMirror has drawn and
   * measured the lines there, the next pass corrects for estimates that were off, until it
   * settles. (Not `EditorView.scrollIntoView`: from far away in a wrapped document, the measure
   * pass after it re-anchors on the old scroll position and throws the jump back.)
   */
  private jumpTo(from: number, to: number, pass = 0) {
    this.view.requestMeasure({
      read: view => {
        const scroller = view.scrollDOM
        const docOffset =
          view.documentTop - scroller.getBoundingClientRect().top + scroller.scrollTop
        // Line blocks include their block widgets, so a zone's own space is covered too.
        const top = docOffset + view.lineBlockAt(from).top
        const bottom = docOffset + view.lineBlockAt(to).bottom
        return top - Math.max(0, (scroller.clientHeight - (bottom - top)) / 2)
      },
      write: target => {
        const scroller = this.view.scrollDOM
        const before = scroller.scrollTop
        scroller.scrollTop = target
        if (Math.abs(scroller.scrollTop - before) > 1 && pass < 4) this.jumpTo(from, to, pass + 1)
      },
    })
  }

  // The strip overlays the scroller rather than sitting inside it, so wheel gestures over it
  // would otherwise scroll nothing.
  private readonly onWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return // pinch-zoom
    event.preventDefault()
    const scroller = this.view.scrollDOM
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight
      : 1
    scroller.scrollBy({ left: event.deltaX * unit, top: event.deltaY * unit })
  }
}

/** Sorts segments and joins touching or overlapping runs of one kind into a single mark. */
export function mergeSegments(segments: readonly OverviewSegment[]): OverviewSegment[] {
  const sorted = segments.toSorted((a, b) => a.top - b.top)
  const merged: OverviewSegment[] = []
  for (const segment of sorted) {
    const last = merged.at(-1)
    if (last && last.kind === segment.kind && segment.top <= last.bottom + 0.5) {
      last.bottom = Math.max(last.bottom, segment.bottom)
      last.from = Math.min(last.from, segment.from)
      last.to = Math.max(last.to, segment.to)
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}
