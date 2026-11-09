import { useEffect, useRef, type ReactNode } from 'react'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { changeAttributes, focusRing, isAttributed, isFocused, type ChangeDecision, type ChangeMarks } from './changeMarks'
import { DocumentPreviewView } from './DocumentPreviewView'
import { PresentationPreviewView } from './PresentationPreviewView'
import { SpreadsheetPreviewView } from './SpreadsheetPreviewView'
import { previewFontFamilies, useWebFonts } from './webFonts'

/**
 * Scrolls `target` to the middle of the preview area holding it (marked `data-preview-scroll`),
 * and nothing else: `scrollIntoView` would also scroll every container around the preview,
 * shifting the Workshop itself.
 */
const revealWithin = (target: Element, behavior: ScrollBehavior) => {
  const area = target.closest('[data-preview-scroll]')
  if (!area) return
  const box = target.getBoundingClientRect()
  const view = area.getBoundingClientRect()
  const left = box.left < view.left || box.right > view.right
    ? area.scrollLeft + box.left - view.left - Math.max(0, (view.width - box.width) / 2)
    : area.scrollLeft
  area.scrollTo({ top: area.scrollTop + box.top - view.top - (view.height - box.height) / 2, left, behavior })
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * A connected Google file drawn as it will be once its pending changes apply, in the product's own
 * look, with each change marked where it lands. Every element showing a change carries
 * `data-change-id` (its ActionLogEntry id) and calls `onChangeClick` with it when clicked. The
 * focused change is outlined, and scrolled to whenever the focus moves to it.
 */
export const ResourcePreviewView = ({ preview, focusedChangeId, decided, onChangeClick, overlay, loading = false }: {
  /** From Overseer.previewResource(): its `actions` are ActionLogEntry ids. */
  preview: ResourcePreview
  focusedChangeId: number | null
  /** Changes already decided, by log id: approved ones are drawn settled, rejected ones undone. */
  decided: ReadonlyMap<number, ChangeDecision>
  onChangeClick: (changeId: number) => void
  /** Floated over the bottom of the file, clear of its own controls (a spreadsheet's sheet tabs). */
  overlay?: ReactNode
  /** `preview` is a blank stand-in (`loadingPreview`) for the file still on its way. */
  loading?: boolean
}) => {
  const root = useRef<HTMLDivElement>(null)
  const marks: ChangeMarks = { focusedChangeId, decided, onChangeClick }

  // A file opens at its top, as it would in its editor; only moving to a change scrolls to it.
  const shownChangeId = useRef(focusedChangeId)
  useEffect(() => {
    if (focusedChangeId === shownChangeId.current) return
    shownChangeId.current = focusedChangeId
    if (focusedChangeId === null || !isAttributed(focusedChangeId)) return
    // The renderers have already switched to the tab, sheet or slide holding the change.
    const target = root.current?.querySelector(`[data-change-id="${focusedChangeId}"]`)
    if (target) revealWithin(target, prefersReducedMotion() ? 'auto' : 'smooth')
  }, [focusedChangeId])

  useWebFonts(previewFontFamilies(preview))
  const { content, actions } = preview
  return (
    <div ref={root} aria-busy={loading || undefined} className="flex h-full min-h-0 flex-col">
      {preview.omitted && preview.omitted.length > 0 && (
        <ul aria-label="Changes not shown" className="shrink-0 space-y-1 border-b border-kumo-line bg-kumo-tint px-4 py-2 text-xs text-kumo-subtle">
          {preview.omitted.map(({ action, reason }, i) => (
            <li key={`${action}-${i}`}>
              {isAttributed(action) ? (
                <button
                  type="button"
                  {...changeAttributes(marks, action)}
                  className="rounded text-left hover:text-kumo-default"
                  style={focusRing(isFocused(marks, action))}
                >
                  Not shown here: {reason}
                </button>
              ) : (
                <span>Not shown here: {reason}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="min-h-0 flex-1">
        {content.type === 'document' && <DocumentPreviewView title={preview.title} content={content} actions={actions} marks={marks} overlay={overlay} loading={loading} />}
        {content.type === 'spreadsheet' && <SpreadsheetPreviewView content={content} actions={actions} marks={marks} overlay={overlay} />}
        {content.type === 'presentation' && <PresentationPreviewView content={content} actions={actions} marks={marks} overlay={overlay} loading={loading} />}
      </div>
    </div>
  )
}
