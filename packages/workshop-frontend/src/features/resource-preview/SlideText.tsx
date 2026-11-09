import type { CSSProperties } from 'react'
import type { SlideParagraph, SlideTextStyle } from '@gadgets/workshop-shared/gatekeeper'
import { safeCssColor } from './safeStyle'
import { BASELINE_SCALE, LEVEL_INDENT, fontPixels, paragraphAlign, SINGLE_LINE_HEIGHT, slideFontStack } from './slideLayout'

const finite = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : 0)

// How Slides draws one run or bullet. Each line is as tall as its largest text needs, so every run
// carries its own line height.
const textStyle = (style: SlideTextStyle, scale: number, spacing: number): CSSProperties => ({
  fontSize: fontPixels(style.fontSize, scale) * (style.baseline ? BASELINE_SCALE : 1),
  lineHeight: SINGLE_LINE_HEIGHT * spacing,
  fontFamily: slideFontStack(style.fontFamily),
  fontWeight: style.bold ? 700 : style.weight !== undefined ? Math.max(100, Math.min(900, style.weight)) : undefined,
  fontStyle: style.italic ? 'italic' : undefined,
  fontVariantCaps: style.smallCaps ? 'small-caps' : undefined,
  textDecorationLine: [style.underline && 'underline', style.strikethrough && 'line-through'].filter(Boolean).join(' ') || undefined,
  color: safeCssColor(style.color),
  backgroundColor: safeCssColor(style.background),
  verticalAlign: style.baseline === 'superscript' ? 'super' : style.baseline === 'subscript' ? 'sub' : undefined,
})

const Paragraph = ({ paragraph, scale }: { paragraph: SlideParagraph; scale: number }) => {
  const spacing = Math.max(0.1, finite(paragraph.lineSpacing) || 100) / 100
  // A list item that sets no indent hangs its text after the bullet, as a new list in Slides does.
  const listDefault = paragraph.bullet && paragraph.indentStart === undefined && paragraph.indentFirstLine === undefined
  const start = listDefault ? LEVEL_INDENT : finite(paragraph.indentStart)
  const firstLine = listDefault ? 0 : paragraph.indentFirstLine ?? start
  const first = paragraph.runs[0] ?? paragraph.bullet ?? {}
  const bulletSize = fontPixels(paragraph.bullet?.fontSize, scale)
  // The bullet's text starts at the paragraph's indent, or just after the bullet if that is past it.
  const bulletGap = (start - firstLine) * scale
  return (
    <p
      style={{
        margin: 0,
        paddingTop: Math.max(0, finite(paragraph.spaceAbove)) * scale,
        paddingBottom: Math.max(0, finite(paragraph.spaceBelow)) * scale,
        paddingLeft: Math.max(0, start) * scale,
        textIndent: (firstLine - start) * scale,
        textAlign: paragraphAlign(paragraph.align),
        ...textStyle({ fontSize: first.fontSize, fontFamily: first.fontFamily }, scale, spacing),
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
      }}
    >
      {paragraph.bullet && (
        <span
          aria-hidden="true"
          style={{
            ...textStyle(paragraph.bullet, scale, spacing),
            display: 'inline-block',
            textIndent: 0,
            minWidth: bulletGap > bulletSize * 0.8 ? bulletGap : undefined,
            paddingRight: bulletGap > bulletSize * 0.8 ? undefined : bulletSize * 0.4,
          }}
        >
          {paragraph.bullet.glyph}
        </span>
      )}
      {paragraph.runs.map((run, i) => <span key={i} style={textStyle(run, scale, spacing)}>{run.text}</span>)}
      {/* An empty paragraph is still a line. */}
      {paragraph.runs.length === 0 && '​'}
    </p>
  )
}

/** Slide text a paragraph at a time, as Slides lays it out at `scale` pixels per point. */
export const SlideText = ({ paragraphs, scale }: { paragraphs: SlideParagraph[]; scale: number }) => (
  <>{paragraphs.map((paragraph, i) => <Paragraph key={i} paragraph={paragraph} scale={scale} />)}</>
)
