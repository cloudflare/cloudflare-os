import { ViewPlugin } from '@codemirror/view'
import type { EditorView, PluginValue, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

// The diff view's overview strip: a narrow column beside the vertical scrollbar marking where
// the changes are in the whole document, scaled to the strip's height, so changes in a long file
// can be found at a glance; pressing the strip scrolls to the spot pressed.
//
// Marks are placed from the editor's own height map rather than line numbers, so block widgets
// (deletion zones, split-layout blank zones) take the space they take on screen.

export type OverviewKind = 'add' | 'modified' | 'delete'

/** A span to mark, in document-relative px (the coordinates of `EditorView.lineBlockAt`). */
export type OverviewSegment = { top: number; bottom: number; kind: OverviewKind }

type Measurement = {
  segments: OverviewSegment[]
  /** Scroll-space y of the document's top (the content padding above the first line). */
  docOffset: number
  scrollHeight: number
  clientHeight: number
  scrollbarWidth: number
  scrollbarHeight: number
}

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
    view.dom.append(this.dom)
    this.scheduleMeasure()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged || update.heightChanged ||
      this.needsUpdate(update)) {
      this.scheduleMeasure()
    }
  }

  destroy() {
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
      scrollbarHeight: scroller.offsetHeight - scroller.clientHeight,
    }
  }

  private write(m: Measurement) {
    // Nothing to find when the whole document is already on screen.
    this.dom.hidden = m.segments.length === 0 || m.scrollHeight <= m.clientHeight
    if (this.dom.hidden) return
    this.dom.style.right = `${m.scrollbarWidth}px`
    this.dom.style.bottom = `${m.scrollbarHeight}px`
    // Percentages scale with the strip's height without measuring it; the stylesheet's
    // min-height keeps a single line visible in a long file.
    const percent = (y: number) => `${((m.docOffset + y) / m.scrollHeight) * 100}%`
    this.dom.replaceChildren(...mergeSegments(m.segments).map(segment => {
      const mark = document.createElement('div')
      mark.className = `gadgets-diff-overview-mark gadgets-diff-overview-${segment.kind}`
      mark.style.top = percent(segment.top)
      mark.style.height = `${((segment.bottom - segment.top) / m.scrollHeight) * 100}%`
      return mark
    }))
  }

  private readonly onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    // Keep the editor's focus and selection where they are.
    event.preventDefault()
    const rect = this.dom.getBoundingClientRect()
    if (rect.height === 0) return
    const scroller = this.view.scrollDOM
    const fraction = (event.clientY - rect.top) / rect.height
    scroller.scrollTop = fraction * scroller.scrollHeight - scroller.clientHeight / 2
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
    } else {
      merged.push({ ...segment })
    }
  }
  return merged
}
