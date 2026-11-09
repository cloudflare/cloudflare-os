import type { ReactNode } from 'react'
import type { PresentationPreview, PresentationSlide } from '@gadgets/workshop-shared/gatekeeper'
import { changeAttributes, changeIdAt, changeState, focusRing, isAttributed, isFocused, type ChangeMarks } from './changeMarks'
import { colors, fonts } from './googleTheme'
import { OVERLAY_CLEARANCE, PreviewOverlay } from './PreviewOverlay'
import { SlideCanvas } from './SlideCanvas'
import { fitSlide } from './slideLayout'
import { useElementSize } from './useElementSize'
import { useRovingTabs, useSelectionFollowingFocus } from './useRovingTabs'

// Slides' editor at 100%, measured from a screenshot of it and scaled to its full size: a filmstrip
// of thumbnails about 168px wide, numbered at their top left, the selected one ringed in a thick,
// rounded blue line; and the slide centred on the same pale surface, edged by a 1px gray line.
const THUMBNAIL_WIDTH = 168
const THUMBNAIL_RING = 3
const THUMBNAIL_RADIUS = 8
const NUMBER_COLUMN = 28
const CANVAS_PADDING = 32
// Above the slide: where a new or deleted slide says so, kept whether or not it does.
const STATUS_ROW = 40
const UNMEASURED_WIDTH = 640

// A slide's status as its decision leaves it: what will happen, then what did.
const STATUS_TEXT = {
  added: { pending: 'New slide', approved: 'Slide added', rejected: 'Slide not added' },
  removed: { pending: 'This slide will be deleted', approved: 'Slide deleted', rejected: 'Slide kept' },
} as const

// The slide's changes that no element shows, such as adding or deleting the slide itself.
const slideLevelChanges = (slide: PresentationSlide, actions: readonly number[]) =>
  slide.changes
    .filter(index => !slide.elements.some(element => element.change === index))
    .map(index => changeIdAt(actions, index))
    .filter((id): id is number => id !== undefined)

const slideHasChange = (slide: PresentationSlide, actions: readonly number[], changeId: number) =>
  slide.changes.some(index => changeIdAt(actions, index) === changeId)
  || slide.elements.some(element => changeIdAt(actions, element.change) === changeId)

// Where a title-and-body slide's text will be, as shares of the slide, so it scales with it.
const SKELETON_LINES = [
  { top: 13, width: 46, height: 7.5 },
  ...[84, 78, 81, 56].map((width, i) => ({ top: 33 + i * 8, width, height: 3.6 })),
]

// A slide still loading: faint bars where its title and text will be, breathing slowly.
const SlideSkeleton = ({ slideWidth }: { slideWidth: number }) => (
  <span aria-hidden="true" className="pointer-events-none absolute inset-0 animate-pulse motion-reduce:animate-none">
    {SKELETON_LINES.map(({ top, width, height }) => (
      <span
        key={top}
        className="absolute"
        style={{ left: '7%', top: `${top}%`, width: `${width}%`, height: `${height}%`, borderRadius: Math.max(2, slideWidth * 0.006), background: colors.loadingLine }}
      />
    ))}
  </span>
)

/** A Google Slides deck as it will be: a filmstrip of every slide and the chosen one large. */
export const PresentationPreviewView = ({ content, actions, marks, overlay, loading = false }: {
  /** Floated over the bottom of the main area: the file's review controls. */
  overlay?: ReactNode
  content: PresentationPreview
  actions: readonly number[]
  marks: ChangeMarks
  /** Draw the slide with placeholder bars: the deck is still loading. */
  loading?: boolean
}) => {
  const slides = content.slides
  const firstChanged = slides.findIndex(slide => slide.changes.length > 0 || slide.elements.some(e => e.change !== undefined))
  const [selected, setSelected] = useSelectionFollowingFocus(Math.max(0, firstChanged), marks.focusedChangeId, changeId => {
    const index = slides.findIndex(slide => slideHasChange(slide, actions, changeId))
    return index === -1 ? undefined : index
  })
  const index = Math.min(selected, Math.max(0, slides.length - 1))
  const tabProps = useRovingTabs({ count: slides.length, selected: index, onSelect: setSelected, orientation: 'vertical' })
  const [canvasRef, canvasSize] = useElementSize<HTMLDivElement>()
  const slideSize = { width: content.width, height: content.height }
  const bottomPadding = overlay ? OVERLAY_CLEARANCE : CANVAS_PADDING
  // Fitted to exactly the room there is, a whole pixel down, so the canvas never overflows: a
  // scrollbar it brought on would narrow the room, shrink the slide, go, and start over.
  // Where there is no layout to measure -- a hidden pane -- the slide takes a default width.
  const fittedWidth = !canvasSize ? 0
    : canvasSize.width === 0 ? UNMEASURED_WIDTH
    : Math.floor(fitSlide({
      width: canvasSize.width - 2 * CANVAS_PADDING,
      height: canvasSize.height - CANVAS_PADDING - bottomPadding - STATUS_ROW,
    }, slideSize).width)
  const slide = slides[index]
  // A slide's own status follows the decision on the change that adds or deletes it.
  const statusChange = slide ? slideLevelChanges(slide, actions)[0] ?? changeIdAt(actions, slide.changes[0]) : undefined
  const statusState = statusChange === undefined ? 'pending' : changeState(marks, statusChange)
  const gone = slide && ((slide.status === 'removed' && statusState !== 'rejected') || (slide.status === 'added' && statusState === 'rejected'))

  return (
    <div className="flex h-full min-h-0 flex-col" style={{ background: colors.slidesWorkspace }}>
      <div className="flex min-h-0 flex-1">
        <div
          role="tablist"
          aria-label="Slides"
          aria-orientation="vertical"
          className="shrink-0 overflow-y-auto pt-3 pb-3 pr-4"
          style={{ width: NUMBER_COLUMN + THUMBNAIL_WIDTH + 2 * THUMBNAIL_RING + 16, fontFamily: fonts.ui }}
        >
          {slides.map((s, i) => {
            const changed = s.changes.length > 0 || s.elements.some(e => e.change !== undefined)
            const isSelected = i === index
            return (
              <button
                key={s.id}
                type="button"
                {...tabProps(i)}
                aria-label={[`Slide ${i + 1}`, s.status === 'added' ? 'new' : s.status === 'removed' ? 'deleted' : null, changed && !s.status ? 'changed' : null].filter(Boolean).join(', ')}
                className="mb-3 flex w-full cursor-pointer items-start text-left focus-visible:outline-none"
              >
                <span
                  className="flex shrink-0 flex-col items-end gap-1 pr-2 text-[12px] leading-4"
                  style={{ width: NUMBER_COLUMN, paddingTop: THUMBNAIL_RING, color: colors.ink, textDecoration: s.status === 'removed' ? 'line-through' : undefined }}
                >
                  {i + 1}
                  {changed && !s.status && <span aria-hidden="true" className="block size-1.5 rounded-full" style={{ background: colors.cellMarker }} />}
                </span>
                <span
                  className="relative block"
                  style={{
                    border: `${THUMBNAIL_RING}px solid ${isSelected ? colors.focus : 'transparent'}`,
                    borderRadius: THUMBNAIL_RADIUS + THUMBNAIL_RING,
                    opacity: s.status === 'removed' ? 0.45 : 1,
                  }}
                >
                  <span
                    className="block overflow-hidden"
                    style={{ borderRadius: THUMBNAIL_RADIUS, position: 'relative' }}
                  >
                    <SlideCanvas slide={s} slideSize={slideSize} renderWidth={THUMBNAIL_WIDTH} actions={actions} marks={marks} interactive={false} />
                    {loading && <SlideSkeleton slideWidth={THUMBNAIL_WIDTH} />}
                    {!isSelected && <span aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ borderRadius: THUMBNAIL_RADIUS, boxShadow: `inset 0 0 0 1px ${colors.thumbnailBorder}` }} />}
                  </span>
                  {s.status === 'added' && (
                    <span className="absolute top-1 right-1 rounded px-1 text-[10px] leading-4 font-medium" style={{ background: colors.badge, color: colors.badgeInk }}>New</span>
                  )}
                </span>
              </button>
            )
          })}
        </div>

        <div className="relative flex min-w-0 flex-1">
        <div ref={canvasRef} data-preview-scroll role="tabpanel" className="flex min-w-0 flex-1 flex-col items-center justify-center overflow-auto" style={{ background: colors.slidesWorkspace, padding: CANVAS_PADDING, paddingBottom: bottomPadding }}>
          {slide && fittedWidth > 0 && (
            <>
              <div className="flex items-end" style={{ height: STATUS_ROW, paddingBottom: 8, fontFamily: fonts.ui }}>
                {slide.status && (
                  statusChange !== undefined && isAttributed(statusChange) ? (
                    <button
                      type="button"
                      {...changeAttributes(marks, statusChange)}
                      aria-label={`Change: ${STATUS_TEXT[slide.status][statusState]}`}
                      className="rounded-full px-3 py-1 text-[12px] font-medium"
                      style={{ background: colors.selectedTab, color: colors.selectedTabInk, ...focusRing(isFocused(marks, statusChange)), textDecoration: statusState === 'rejected' ? 'line-through' : undefined }}
                    >
                      {STATUS_TEXT[slide.status][statusState]}
                    </button>
                  ) : (
                    <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={{ background: colors.selectedTab, color: colors.selectedTabInk }}>{STATUS_TEXT[slide.status][statusState]}</span>
                  )
                )}
              </div>
              <div className="relative" style={{ boxShadow: `0 0 0 1px ${colors.slideBorder}`, opacity: gone ? 0.45 : 1 }}>
                <SlideCanvas
                  slide={slide}
                  slideSize={slideSize}
                  renderWidth={fittedWidth}
                  actions={actions}
                  marks={marks}
                  interactive
                  label={`Slide ${index + 1} of ${slides.length}${slide.status === 'added' ? ', new' : slide.status === 'removed' ? ', deleted' : ''}`}
                />
                {loading && <SlideSkeleton slideWidth={fittedWidth} />}
              </div>
            </>
          )}
        </div>
        {overlay && <PreviewOverlay>{overlay}</PreviewOverlay>}
        </div>
      </div>
    </div>
  )
}
