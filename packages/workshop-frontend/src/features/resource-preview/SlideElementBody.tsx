import type { CSSProperties } from 'react'
import { Image as ImageIcon } from '@phosphor-icons/react'
import type { SlideArrow, SlideElement, SlideShadow, SlideStroke, SlideTable } from '@gadgets/workshop-shared/gatekeeper'
import { colors } from './googleTheme'
import { safeCssColor, safeImageDataUrl } from './safeStyle'
import { geometryPath } from './slideGeometry'
import { CELL_INSET, TEXT_INSET, dashArray, strokePixels } from './slideLayout'
import { SlideText } from './SlideText'

const finite = (value: number | undefined, fallback = 0) => (value !== undefined && Number.isFinite(value) ? value : fallback)

const JUSTIFY = { middle: 'center', bottom: 'flex-end' } as const

const shadowFilter = (shadow: SlideShadow | undefined, scale: number) => {
  const color = safeCssColor(shadow?.color)
  if (!shadow || !color) return undefined
  return `drop-shadow(${finite(shadow.x) * scale}px ${finite(shadow.y) * scale}px ${Math.max(0, finite(shadow.blur)) * scale}px ${color})`
}

/** SVG attributes for `stroke`, or none to draw it with. */
const strokeProps = (stroke: SlideStroke | undefined, scale: number) => {
  const color = safeCssColor(stroke?.color)
  if (!stroke || !color) return { stroke: 'none' }
  const width = strokePixels(stroke, scale)
  return { stroke: color, strokeWidth: width, strokeDasharray: dashArray(stroke.dash, width) }
}

// A shape's outline is drawn centred on its edge, as Slides draws it, so it may spill past the box.
const Outline = ({ element, scale, fill }: { element: SlideElement; scale: number; fill?: string }) => {
  const width = Math.max(0, finite(element.width)) * scale
  const height = Math.max(0, finite(element.height)) * scale
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, overflow: 'visible', filter: shadowFilter(element.shadow, scale) }}
    >
      <path
        d={geometryPath(element.kind === 'shape' ? element.geometry : undefined, width, height)}
        transform={element.flipped ? `matrix(1 0 0 -1 0 ${height})` : undefined}
        fill={fill ?? 'none'}
        strokeLinejoin="miter"
        {...strokeProps(element.outline, scale)}
      />
    </svg>
  )
}

const ShapeBody = ({ element, scale }: { element: SlideElement; scale: number }) => {
  const fill = safeCssColor(element.fill)
  return (
    <>
      {(fill || element.outline) && <Outline element={element} scale={scale} fill={fill} />}
      {element.text && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            padding: TEXT_INSET * scale,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: element.verticalAlign ? JUSTIFY[element.verticalAlign] : 'flex-start',
          }}
        >
          <div><SlideText paragraphs={element.text} scale={scale} /></div>
        </div>
      )}
    </>
  )
}

// The part of a picture a crop keeps, stretched over the element's box.
const croppedPlacement = (crop: SlideElement['crop']): CSSProperties => {
  const { left = 0, top = 0, right = 0, bottom = 0 } = crop ?? {}
  const keptX = 1 - finite(left) - finite(right)
  const keptY = 1 - finite(top) - finite(bottom)
  if (!crop || keptX <= 0 || keptY <= 0) return { width: '100%', height: '100%' }
  return {
    position: 'absolute',
    // Turned about the picture's own centre, as Slides turns a crop.
    transform: crop.angle ? `rotate(${finite(crop.angle)}deg)` : undefined,
    width: `${100 / keptX}%`,
    height: `${100 / keptY}%`,
    left: `${(-finite(left) / keptX) * 100}%`,
    top: `${(-finite(top) / keptY) * 100}%`,
    maxWidth: 'none',
  }
}

const ImageBody = ({ element, scale }: { element: SlideElement; scale: number }) => {
  const src = safeImageDataUrl(element.image)
  return (
    <>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          opacity: element.opacity === undefined ? undefined : Math.max(0, Math.min(1, finite(element.opacity, 1))),
          filter: element.outline ? undefined : shadowFilter(element.shadow, scale),
          transform: element.flipped ? 'scaleY(-1)' : undefined,
        }}
      >
        {src
          ? <img src={src} alt="" draggable={false} style={{ display: 'block', objectFit: 'fill', ...croppedPlacement(element.crop) }} />
          : (
              <div className="flex size-full items-center justify-center" style={{ background: colors.imagePlaceholder, color: colors.imagePlaceholderInk }}>
                <ImageIcon size={Math.max(8, Math.min(48, 0.3 * Math.min(element.width, element.height) * scale))} aria-hidden="true" />
              </div>
            )}
      </div>
      {element.outline && <Outline element={element} scale={scale} />}
    </>
  )
}

/** How far the hit area of a line reaches either side of it, in pixels. */
export const linePadding = (element: SlideElement, scale: number) =>
  Math.max(4, (element.outline ? strokePixels(element.outline, scale) : 1) / 2 + 3)

/**
 * An arrowhead at `x` on a line along y = 0, pointing in `direction` (1 for right), `size` pixels
 * long; and how far back the line stops so it does not poke through.
 */
function arrowhead(arrow: SlideArrow, x: number, direction: 1 | -1, size: number, stroke: string, width: number) {
  const back = (distance: number) => x - direction * distance
  const half = size / 2
  const filled = { fill: stroke, stroke: 'none' }
  const open = { fill: 'none', stroke, strokeWidth: width, strokeLinejoin: 'miter' as const }
  switch (arrow) {
    case 'fillArrow':
      return { inset: size * 0.9, shape: <path d={`M${x},0 L${back(size)},${-half} L${back(size)},${half} Z`} {...filled} /> }
    case 'stealthArrow':
      return { inset: size * 0.6, shape: <path d={`M${x},0 L${back(size)},${-half} L${back(size * 0.6)},0 L${back(size)},${half} Z`} {...filled} /> }
    case 'openArrow':
      return { inset: width / 2, shape: <path d={`M${back(size)},${-half} L${x},0 L${back(size)},${half}`} {...open} /> }
    case 'fillCircle':
    case 'openCircle':
      return { inset: arrow === 'fillCircle' ? 0 : half * 0.7, shape: <circle cx={x} cy={0} r={half * 0.7} {...(arrow === 'fillCircle' ? filled : open)} /> }
    case 'fillSquare':
    case 'openSquare':
      return { inset: arrow === 'fillSquare' ? 0 : half * 0.6, shape: <rect x={x - half * 0.6} y={-half * 0.6} width={half * 1.2} height={half * 1.2} {...(arrow === 'fillSquare' ? filled : open)} /> }
    case 'fillDiamond':
    case 'openDiamond':
      return { inset: arrow === 'fillDiamond' ? 0 : half * 0.8, shape: <path d={`M${x - half * 0.8},0 L${x},${-half * 0.8} L${x + half * 0.8},0 L${x},${half * 0.8} Z`} {...(arrow === 'fillDiamond' ? filled : open)} /> }
  }
}

const LineBody = ({ element, scale }: { element: SlideElement; scale: number }) => {
  const length = Math.max(0, finite(element.width)) * scale
  const stroke = safeCssColor(element.outline?.color) ?? colors.slideInk
  const width = element.outline ? strokePixels(element.outline, scale) : Math.max(0.5, 0.75 * scale)
  // Slides grows an arrowhead with its line, but keeps a thin line's legible.
  const size = Math.max(3 * width, 5 * scale)
  const start = element.startArrow ? arrowhead(element.startArrow, 0, -1, size, stroke, width) : undefined
  const end = element.endArrow ? arrowhead(element.endArrow, length, 1, size, stroke, width) : undefined
  const pad = linePadding(element, scale)
  return (
    <svg aria-hidden="true" width={length} height={pad * 2} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      <g transform={`translate(0 ${pad})`}>
        <line
          x1={start?.inset ?? 0}
          x2={length - (end?.inset ?? 0)}
          y1={0}
          y2={0}
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dashArray(element.outline?.dash, width)}
        />
        {start?.shape}
        {end?.shape}
      </g>
    </svg>
  )
}

const borderCss = (stroke: SlideStroke | null | undefined, scale: number) => {
  const color = safeCssColor(stroke?.color ?? undefined)
  if (!stroke || !color) return 'none'
  const style = stroke.dash === 'dot' ? 'dotted' : stroke.dash ? 'dashed' : 'solid'
  return `${strokePixels(stroke, scale)}px ${style} ${color}`
}

const TableBody = ({ table, scale }: { table: SlideTable; scale: number }) => {
  const rows = table.rows.length
  const columns = table.columns.length
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: table.columns.map(width => `${Math.max(0, finite(width)) * scale}px`).join(' '),
        // Slides grows a row to fit its text.
        gridTemplateRows: table.rows.map(height => `minmax(${Math.max(0, finite(height)) * scale}px, auto)`).join(' '),
      }}
    >
      {table.cells.flatMap((row, r) => row.map((cell, c) => {
        if (!cell || r >= rows || c >= columns) return null
        const rowSpan = Math.max(1, Math.min(cell.rowSpan ?? 1, rows - r))
        const columnSpan = Math.max(1, Math.min(cell.columnSpan ?? 1, columns - c))
        return (
          <div
            key={`${r}:${c}`}
            style={{
              gridRow: `${r + 1} / span ${rowSpan}`,
              gridColumn: `${c + 1} / span ${columnSpan}`,
              background: safeCssColor(cell.fill),
              borderTop: borderCss(table.horizontalBorders[r]?.[c], scale),
              borderLeft: borderCss(table.verticalBorders[r]?.[c], scale),
              borderBottom: r + rowSpan === rows ? borderCss(table.horizontalBorders[rows]?.[c], scale) : undefined,
              borderRight: c + columnSpan === columns ? borderCss(table.verticalBorders[r]?.[columns], scale) : undefined,
              padding: `${CELL_INSET.y * scale}px ${CELL_INSET.x * scale}px`,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: cell.verticalAlign ? JUSTIFY[cell.verticalAlign] : 'flex-start',
              minWidth: 0,
            }}
          >
            {cell.text && <div><SlideText paragraphs={cell.text} scale={scale} /></div>}
          </div>
        )
      }))}
    </div>
  )
}

/** One element of a slide as Slides draws it, filling its box at `scale` pixels per point. */
export const SlideElementBody = ({ element, scale }: { element: SlideElement; scale: number }) => {
  switch (element.kind) {
    case 'image':
      return <ImageBody element={element} scale={scale} />
    case 'line':
      return <LineBody element={element} scale={scale} />
    case 'table':
      return element.table ? <TableBody table={element.table} scale={scale} /> : null
    default:
      return <ShapeBody element={element} scale={scale} />
  }
}
