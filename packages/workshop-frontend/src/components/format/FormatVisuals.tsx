// The ways an output format is drawn:
//
//   <FormatGlyph>     bare icon             workspace tab, menus, pickers, command palette
//   <FormatMiniature> icon on a small tile  chat cards
//   <FormatTile>      icon on a tile        Outputs list rows
//   <FormatThumbnail> wireframe drawing     Outputs grid cards
//   <FormatPreview>   wireframe drawing     admin Formats panel
//
// The wireframes are abstract: unlike a screenshot they look right before the output has any
// content, which is when the user is deciding what to make.

import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { FORMAT_ICONS, formatOf, wireframeOf, type FormatWireframe } from './formats'

// ─── glyph ───────────────────────────────────────────────────────────────────

const GLYPH_SIZES = { sm: 11, md: 15, lg: 17 } as const

export function FormatGlyph({
  output,
  size = 'md',
  className,
  weight,
}: {
  output?: BlueprintOutput
  size?: keyof typeof GLYPH_SIZES
  className?: string
  weight?: 'regular' | 'fill'
}) {
  const Icon = FORMAT_ICONS[formatOf(output).icon]
  return <Icon size={GLYPH_SIZES[size]} className={className} weight={weight} />
}

// ─── tile ────────────────────────────────────────────────────────────────────

// Tile dimensions and the glyph size that suits each, keyed together so they can't drift.
const TILE_SIZES = {
  sm: { box: 'h-7 w-7 rounded-lg', glyph: 'sm' },
  md: { box: 'h-9 w-9 rounded-lg', glyph: 'md' },
  lg: { box: 'h-10 w-10 rounded-xl', glyph: 'lg' },
} as const

export function FormatTile({
  output,
  size = 'md',
  className = '',
}: {
  output?: BlueprintOutput
  size?: keyof typeof TILE_SIZES
  className?: string
}) {
  const { box, glyph } = TILE_SIZES[size]
  return (
    <div
      className={`grid ${box} shrink-0 place-items-center bg-kumo-fill text-kumo-subtle ${className}`}
    >
      <FormatGlyph output={output} size={glyph} />
    </div>
  )
}

// ─── wireframes ──────────────────────────────────────────────────────────────

const BAR = 'rounded-[2px] bg-kumo-line'
const BAR_STRONG = 'rounded-[2px] bg-kumo-fill'

function PageWireframe() {
  return (
    <div className="flex h-full flex-col gap-[6px]">
      <div className={`h-2 w-1/2 ${BAR_STRONG}`} />
      <div className="mt-1 flex flex-col gap-[5px]">
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[94%] ${BAR}`} />
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[72%] ${BAR}`} />
      </div>
      <div className="mt-1.5 flex flex-col gap-[5px]">
        <div className={`h-1.5 w-full ${BAR}`} />
        <div className={`h-1.5 w-[88%] ${BAR}`} />
        <div className={`h-1.5 w-[60%] ${BAR}`} />
      </div>
    </div>
  )
}

function GridWireframe() {
  return (
    <div className="flex h-full flex-col gap-px overflow-hidden rounded-[3px] bg-kumo-line">
      {Array.from({ length: 6 }).map((_, r) => (
        <div key={r} className="grid flex-1 grid-cols-4 gap-px">
          {Array.from({ length: 4 }).map((__, c) => (
            <div key={c} className={r === 0 || c === 0 ? 'bg-kumo-fill' : 'bg-kumo-base'} />
          ))}
        </div>
      ))}
    </div>
  )
}

// A deck: one slide framed above a filmstrip of the others. The filmstrip carries the idea, since
// a single slide's layout reads equally as a document page.
//
// Sized in percentages because this drawing also has to survive FormatMiniature, which shrinks the
// box without scaling the contents.
function SlideWireframe() {
  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex flex-1 flex-col justify-center gap-1.5 overflow-hidden rounded-[3px] border border-kumo-line px-2">
        <div className={`h-2 w-3/5 ${BAR_STRONG}`} />
        <div className={`h-1.5 w-[85%] ${BAR}`} />
      </div>

      <div className="flex h-[20%] shrink-0 gap-1 overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`h-full w-[26%] shrink-0 rounded-[2px] ${i === 0 ? BAR_STRONG : BAR}`} />
        ))}
      </div>
    </div>
  )
}

function WindowWireframe() {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-1">
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-line" />
        <div className={`ml-1 h-1.5 flex-1 ${BAR}`} />
      </div>
      <div className="flex flex-1 gap-2">
        <div className="flex w-1/4 flex-col gap-1.5">
          <div className={`h-1.5 w-full ${BAR}`} />
          <div className={`h-1.5 w-3/4 ${BAR}`} />
          <div className={`h-1.5 w-full ${BAR}`} />
          <div className={`h-1.5 w-2/3 ${BAR}`} />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="h-5 rounded-[3px] bg-kumo-tint" />
            <div className="h-5 rounded-[3px] bg-kumo-tint" />
          </div>
          <div className="flex flex-1 items-end gap-1.5">
            {[55, 80, 40, 95, 65, 75].map((h, i) => (
              <div key={i} className={`flex-1 ${BAR_STRONG}`} style={{ height: `${h}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// A checklist: short leading marks against lines of text.
function ListWireframe() {
  return (
    <div className="flex h-full flex-col gap-[7px]">
      <div className={`h-2 w-2/5 ${BAR_STRONG}`} />
      {[92, 78, 96, 64, 84].map((w, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-[1px] bg-kumo-fill" />
          <span className={`h-1.5 ${BAR}`} style={{ width: `${w}%` }} />
        </div>
      ))}
    </div>
  )
}

// A board: columns of stacked cards, for kanban- and flow-shaped things.
function BoardWireframe() {
  return (
    <div className="flex h-full gap-1.5">
      {[[10, 16], [16, 10, 8], [12]].map((cards, col) => (
        <div key={col} className="flex flex-1 flex-col gap-1.5">
          <div className={`h-1.5 w-3/4 ${BAR}`} />
          {cards.map((h, i) => (
            <div key={i} className="rounded-[3px] bg-kumo-fill" style={{ height: `${h}px` }} />
          ))}
        </div>
      ))}
    </div>
  )
}

// A chart: a titled plot with an axis, for report-shaped things.
function ChartWireframe() {
  return (
    <div className="flex h-full flex-col gap-2">
      <div className={`h-2 w-1/2 ${BAR_STRONG}`} />
      <div className="flex flex-1 items-end gap-1.5 border-b border-l border-kumo-line pb-1 pl-1">
        {[45, 70, 35, 90, 60, 78, 50].map((h, i) => (
          <div key={i} className={`flex-1 rounded-t-[2px] bg-kumo-fill`} style={{ height: `${h}%` }} />
        ))}
      </div>
      <div className="flex gap-1.5">
        <div className={`h-1.5 w-1/3 ${BAR}`} />
        <div className={`h-1.5 w-1/4 ${BAR}`} />
      </div>
    </div>
  )
}

const WIREFRAMES: Record<FormatWireframe, () => React.JSX.Element> = {
  page: PageWireframe,
  grid: GridWireframe,
  slide: SlideWireframe,
  window: WindowWireframe,
  list: ListWireframe,
  board: BoardWireframe,
  chart: ChartWireframe,
}

// ─── thumbnail ───────────────────────────────────────────────────────────────

/**
 * A wireframe on a "page" that floats over a tinted backdrop and bleeds off the bottom edge, the
 * way a document manager previews a file. `inset` scales the page for small cards; `chrome`
 * borders it for use outside a card that already has a border.
 */
export function FormatThumbnail({
  output,
  className = '',
}: {
  output?: BlueprintOutput
  className?: string
}) {
  const Wireframe = WIREFRAMES[wireframeOf(output)]
  return (
    <div className={`absolute inset-0 bg-kumo-tint ${className}`} aria-hidden="true">
      <div className="themed-thumbnail-shadow absolute left-1/2 top-4 h-[calc(100%-1rem)] w-[78%] -translate-x-1/2 overflow-hidden rounded-t-[6px] bg-kumo-base ring-1 ring-kumo-line/20">
        <div className="h-full w-full p-3.5">
          <Wireframe />
        </div>
      </div>
    </div>
  )
}

// The size the wireframes are drawn for: bar heights, gaps and insets are in pixels, so they only
// read correctly at roughly the size of an Outputs card. Anything smaller scales the whole
// drawing.
const PREVIEW_WIDTH = 200
const PREVIEW_HEIGHT = 150

/**
 * A self-contained miniature of the Outputs card at any width, for showing the thumbnail itself
 * (the admin icon picker) rather than filling a card.
 */
export function FormatPreview({ output, width = 120 }: { output?: BlueprintOutput; width?: number }) {
  const scale = width / PREVIEW_WIDTH
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-md border border-kumo-line"
      style={{ width, height: PREVIEW_HEIGHT * scale }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, transform: `scale(${scale})` }}
      >
        <FormatThumbnail output={output} />
      </div>
    </div>
  )
}

/**
 * The same drawing at card-inset scale, for places that need a small self-contained picture rather
 * than an absolutely-positioned backdrop (e.g. the chat "created app" card). Sized by its parent.
 */
export function FormatMiniature({ output }: { output?: BlueprintOutput }) {
  const Wireframe = WIREFRAMES[wireframeOf(output)]
  return (
    <span
      className="relative flex h-[52px] w-[62px] overflow-hidden rounded-md border border-kumo-line bg-kumo-base p-1.5 shadow-sm"
      aria-hidden="true"
    >
      <span className="flex-1 [&_*]:!rounded-[1px]">
        <Wireframe />
      </span>
    </span>
  )
}
