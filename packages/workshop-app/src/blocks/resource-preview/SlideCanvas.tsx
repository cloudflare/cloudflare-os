import type { CSSProperties } from 'react'
import type { PresentationSlide, SlideElement } from '@gadgets/workshop-shared/gatekeeper'
import { changeIdAt, changeLabel, changeState, inlineChangeProps, isAttributed, isFocused, type ChangeMarks } from './changeMarks'
import { colors, fonts } from './googleTheme'
import { safeCssColor, safeImageDataUrl } from './safeStyle'
import { SlideElementBody, linePadding } from './SlideElementBody'
import { DEFAULT_FONT_SIZE, elementBox, elementText, fontPixels, slideScale } from './slideLayout'

/** Where an element sits at `scale`; a line's box is widened about it into something to click. */
const placement = (element: SlideElement, scale: number): CSSProperties => {
  const box = elementBox(element, scale)
  if (element.kind !== 'line') return box
  const pad = linePadding(element, scale)
  return { ...box, top: Number(box.top) - pad, height: pad * 2 }
}

/**
 * One slide drawn from its elements at `renderWidth` pixels wide. Interactive, each changed element
 * is a button marking its change; as a thumbnail (`interactive` false) it is a picture only. Like
 * the slide in Slides' editor, nothing on it is selectable, and only a change shows a pointer.
 */
export const SlideCanvas = ({ slide, slideSize, renderWidth, actions, marks, interactive, label }: {
  slide: PresentationSlide
  slideSize: { width: number; height: number }
  renderWidth: number
  actions: readonly number[]
  marks: ChangeMarks
  interactive: boolean
  /** The canvas's accessible name; a thumbnail has none, as it is hidden from assistive tech. */
  label?: string
}) => {
  const scale = slideScale(renderWidth, slideSize.width)
  const backgroundImage = safeImageDataUrl(slide.backgroundImage)
  return (
    <div
      role={interactive ? 'group' : undefined}
      aria-label={interactive ? label : undefined}
      aria-hidden={interactive ? undefined : true}
      style={{
        position: 'relative',
        width: renderWidth,
        height: slideSize.height * scale,
        overflow: 'hidden',
        background: safeCssColor(slide.background) ?? colors.page,
        fontFamily: fonts.document,
        fontSize: fontPixels(DEFAULT_FONT_SIZE, scale),
        color: colors.slideInk,
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {backgroundImage && (
        <img src={backgroundImage} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'fill' }} />
      )}
      {slide.elements.map(element => {
        const changeId = changeIdAt(actions, element.change)
        const box = placement(element, scale)
        if (changeId === undefined) {
          return <div key={element.id} style={box}><SlideElementBody element={element} scale={scale} /></div>
        }
        const state = changeState(marks, changeId)
        const decided: CSSProperties = state === 'rejected' ? { opacity: 0.35, textDecorationLine: 'line-through' } : {}
        if (!interactive) {
          return <div key={element.id} style={{ ...box, ...decided }}><SlideElementBody element={element} scale={scale} /></div>
        }
        const focused = isFocused(marks, changeId)
        const text = elementText(element)
        const mark: CSSProperties = focused
          ? { outline: `2px solid ${colors.focus}`, outlineOffset: 2 }
          : state === 'pending' ? { outline: `1.5px dashed ${colors.changedElement}`, outlineOffset: 2 } : {}
        return (
          <div
            key={element.id}
            {...inlineChangeProps(marks, changeId, changeLabel(text || element.kind))}
            style={{ ...box, ...decided, ...mark, cursor: isAttributed(changeId) ? 'pointer' : undefined }}
          >
            <SlideElementBody element={element} scale={scale} />
          </div>
        )
      })}
    </div>
  )
}
