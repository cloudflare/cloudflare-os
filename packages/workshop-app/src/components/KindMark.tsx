import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

// Ink is the page's opposite, as a workspace's folder (`WorkspaceIcon`) and a chat's cloud
// (`ChatMark`) are drawn: black in light, white in dark. What is cut out of it is the page's own
// colour, and what is drawn into it, a shade of that over the ink, as the folder's front is.
const INK = 'fill-kumo-contrast'
const CUT = { fill: 'currentColor' }
const SHADE = { fill: 'currentColor', fillOpacity: 0.18 }
const LINE = { stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const

// A page, its top right folded down, on the 32 grid: what a file and a document are drawn on.
const PAGE = 'M11 1.5h7.6a3 3 0 0 1 2.12.88l6.4 6.4a3 3 0 0 1 .88 2.12V24.5a6 6 0 0 1-6 6H11a6 6 0 0 1-6-6v-17a6 6 0 0 1 6-6Z'
const FOLD = 'M19.5 1.8v5.7a3 3 0 0 0 3 3h5.7'
const Page = ({ children }: { children?: ReactNode }) => (
  <>
    <path d={PAGE} className={INK} />
    <path d={`${FOLD}Z`} {...SHADE} />
    {children}
  </>
)

// The pills a page's lines are drawn as, cut out of it.
const Bar = ({ x, y, width, faint }: { x: number; y: number; width: number; faint?: boolean }) => (
  <rect x={x} y={y} width={width} height={2.5} rx={1.25} {...CUT} fillOpacity={faint ? 0.55 : 1} />
)

const MARKS = {
  // A gadget: a window, its content set into it.
  gadget: (
    <>
      <rect x="1" y="3" width="30" height="26" rx="8" className={INK} />
      <rect x="4.5" y="10.5" width="23" height="15" rx="4" {...SHADE} />
      <circle cx="7" cy="6.75" r="1.5" {...CUT} />
      <circle cx="11.5" cy="6.75" r="1.5" {...CUT} />
    </>
  ),
  document: (
    <Page>
      <Bar x={10} y={14.5} width={12} />
      <Bar x={10} y={20.5} width={8} faint />
    </Page>
  ),
  // A sheet: its cells cut out of it, the header row in full.
  spreadsheet: (
    <>
      <rect x="2" y="2" width="28" height="28" rx="8" className={INK} />
      {[7, 13.75, 20.5].flatMap((y, row) => [[6, 4], [11.5, 7], [20, 6]].map(([x, width]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={width} height={4.75} rx={1.5} {...CUT} fillOpacity={row === 0 ? 1 : 0.55} />
      )))}
    </>
  ),
  // A deck: a slide, with the next behind it.
  presentation: (
    <>
      <rect x="6" y="2.5" width="25" height="19" rx="5.5" className={INK} fillOpacity={0.4} />
      <rect x="1" y="8" width="25" height="20" rx="6" className={INK} />
      <Bar x={6} y={13.5} width={11} />
      <Bar x={6} y={19.5} width={7} faint />
    </>
  ),
  chart: (
    <>
      <rect x="2" y="15" width="8" height="15" rx="4" className={INK} />
      <rect x="12" y="2" width="8" height="28" rx="4" className={INK} />
      <rect x="22" y="9" width="8" height="21" rx="4" className={INK} />
    </>
  ),
  // A board: cards in columns, set into it.
  board: (
    <>
      <rect x="1" y="3" width="30" height="26" rx="8" className={INK} />
      <rect x="5" y="7" width="6" height="12" rx="2.5" {...CUT} />
      <rect x="13" y="7" width="6" height="17" rx="2.5" {...CUT} fillOpacity={0.55} />
      <rect x="21" y="7" width="6" height="7" rx="2.5" {...CUT} fillOpacity={0.55} />
    </>
  ),
  checklist: (
    <>
      <rect x="2" y="2" width="28" height="28" rx="8" className={INK} />
      <path d="m7.5 11.25 2.25 2.25 4.25-4.5" {...LINE} />
      <Bar x={17} y={10} width={8} />
      <circle cx="10" cy="21.25" r="2" {...CUT} fillOpacity={0.55} />
      <Bar x={17} y={20} width={8} faint />
    </>
  ),
  // A notebook: its spine in shade, a ribbon marking the place.
  notebook: (
    <>
      <rect x="4" y="1.5" width="24" height="29" rx="6" className={INK} />
      <path d="M10 1.5H4.6v29H10Z" {...SHADE} />
      <path d="M17.5 1.5v10l2.75-2.25L23 11.5v-10Z" {...CUT} />
    </>
  ),
  // A flow: one step leading to the next.
  flow: (
    <>
      <path d="M7.5 13v6a5 5 0 0 0 5 5H19" {...LINE} className="stroke-kumo-contrast" stroke={undefined} strokeWidth={3} />
      <rect x="1" y="1" width="13" height="13" rx="4.5" className={INK} />
      <rect x="18" y="18" width="13" height="13" rx="4.5" className={INK} />
    </>
  ),
  grid: (
    <>
      {[1, 12, 23].flatMap((y) => [1, 12, 23].map((x) => <rect key={`${x},${y}`} x={x} y={y} width="8" height="8" rx="3" className={INK} />))}
    </>
  ),
  // Many of something, as the Library keeps them: cards fanned from their foot, as the card to all
  // of them (`FanCard`) fans them, each parted from the one behind.
  collection: (
    <>
      <rect x="7.5" y="4" width="17" height="24" rx="5" className={INK} fillOpacity={0.35} transform="rotate(-14 16 46)" />
      <rect x="7.5" y="4" width="17" height="24" rx="5" className={INK} fillOpacity={0.6} transform="rotate(14 16 46)" />
      <rect x="7" y="4" width="18" height="26" rx="5.5" className={INK} stroke="currentColor" strokeWidth="2" paintOrder="stroke" />
    </>
  ),
  // A branch: a line of work leaving another, to come back to it.
  branch: (
    <>
      <path d="M9 9v14M23 13.5c0 4.5-3 7-7 7h-3a4 4 0 0 0-4 4" {...LINE} className="stroke-kumo-contrast" stroke={undefined} strokeWidth={3} />
      <circle cx="9" cy="6" r="4.5" className={INK} />
      <circle cx="9" cy="26" r="4.5" className={INK} />
      <circle cx="23" cy="10" r="4.5" className={INK} />
    </>
  ),
  // A calendar: its rings standing up out of it, its days cut out of it, today in full.
  calendar: (
    <>
      <rect x="2" y="4" width="28" height="26" rx="7" className={INK} />
      {[8.5, 20.5].map((x) => (
        <rect key={x} x={x} y="1" width="3" height="7.5" rx="1.5" className={INK} stroke="currentColor" strokeWidth="1.5" paintOrder="stroke" />
      ))}
      {[13.5, 20.5].flatMap((y, row) => [7, 13.75, 20.5].map((x, column) => (
        <rect key={`${x},${y}`} x={x} y={y} width={4.5} height={4.5} rx={1.5} {...CUT} fillOpacity={row === 0 && column === 0 ? 1 : 0.55} />
      )))}
    </>
  ),
  // An inbox: an envelope, its flap cut into it.
  inbox: (
    <>
      <rect x="1" y="5" width="30" height="22" rx="6" className={INK} />
      <path d="m6 10.5 10 7 10-7" {...LINE} />
    </>
  ),
  // A form: a clipboard, its clip parted from it, two fields and the button that sends them.
  form: (
    <>
      <rect x="4" y="3.5" width="24" height="27" rx="6" className={INK} />
      <rect x="11" y="1" width="10" height="5.5" rx="2.5" className={INK} stroke="currentColor" strokeWidth="1.5" paintOrder="stroke" />
      <rect x="8.5" y="11" width="15" height="4" rx="1.5" {...CUT} fillOpacity={0.55} />
      <rect x="8.5" y="17.5" width="15" height="4" rx="1.5" {...CUT} fillOpacity={0.55} />
      <rect x="8.5" y="24" width="7" height="2.5" rx="1.25" {...CUT} />
    </>
  ),
  // A map: folded in three, its middle fold in shade.
  map: (
    <>
      <path d="M3 7.5 11 4.5l10 3 8-3v20l-8 3-10-3-8 3Z" className={INK} stroke={undefined} />
      <path d="M3 7.5 11 4.5l10 3 8-3v20l-8 3-10-3-8 3Z" {...LINE} className="stroke-kumo-contrast" stroke={undefined} strokeWidth={4} />
      <path d="M11 4.5 21 7.5v20l-10-3Z" {...SHADE} />
    </>
  ),
  // A dashboard: a gauge, its needle up.
  dashboard: (
    <>
      <rect x="2" y="2" width="28" height="28" rx="8" className={INK} />
      <path d="M8.5 21a7.5 7.5 0 0 1 15 0" {...LINE} fillOpacity={0} strokeOpacity={0.55} />
      <path d="m16 21 4-5.5" {...LINE} />
      <circle cx="16" cy="21" r="2.25" {...CUT} />
    </>
  ),
  // A database: a stack of discs, its lid in shade.
  database: (
    <>
      <path d="M3 8c0-2.76 5.82-5 13-5s13 2.24 13 5v16c0 2.76-5.82 5-13 5S3 26.76 3 24Z" className={INK} />
      <ellipse cx="16" cy="8" rx="13" ry="5" {...SHADE} />
      <path d="M3 14.5c0 2.76 5.82 5 13 5s13-2.24 13-5M3 20.5c0 2.76 5.82 5 13 5s13-2.24 13-5" {...LINE} strokeWidth={1.75} />
    </>
  ),
  // A schedule: a clock, as what runs by itself runs.
  schedule: (
    <>
      <circle cx="16" cy="16" r="14" className={INK} />
      <path d="M16 9v7l4.5 3" {...LINE} />
    </>
  ),
  // An agent: a spark, with a smaller one beside it in shade.
  agent: (
    <>
      <path d="M14 3.5C15 10 18 13.5 25.5 16 18 18.5 15 22 14 28.5 13 22 10 18.5 2.5 16 10 13.5 13 10 14 3.5Z" {...LINE} className="fill-kumo-contrast stroke-kumo-contrast" stroke={undefined} fill={undefined} strokeWidth={2.5} />
      <path d="M25.5 1.5c.5 2.5 1.5 3.5 4 4-2.5.5-3.5 1.5-4 4-.5-2.5-1.5-3.5-4-4 2.5-.5 3.5-1.5 4-4Z" {...LINE} className="fill-kumo-contrast stroke-kumo-contrast" stroke={undefined} fill={undefined} strokeWidth={1.5} opacity={0.45} />
    </>
  ),
  // People: one in front of another, parted from them.
  people: (
    <>
      <circle cx="22" cy="9" r="4.5" className={INK} fillOpacity={0.45} />
      <path d="M15 26a8 8 0 0 1 15 0v1.5H15Z" className={INK} fillOpacity={0.45} />
      <circle cx="12.5" cy="10.5" r="5.5" className={INK} stroke="currentColor" strokeWidth="2" paintOrder="stroke" />
      <path d="M2.5 28.5a10 10 0 0 1 20 0v.5a1 1 0 0 1-1 1h-18a1 1 0 0 1-1-1Z" className={INK} stroke="currentColor" strokeWidth="2" paintOrder="stroke" />
    </>
  ),
  // The web: a globe, its meridian and equator cut out of it.
  web: (
    <>
      <circle cx="16" cy="16" r="14" className={INK} />
      <ellipse cx="16" cy="16" rx="5.5" ry="13" {...LINE} strokeWidth={2} />
      <path d="M3 16h26" {...LINE} strokeWidth={2} />
    </>
  ),
  file: <Page />,
  image: (
    <Page>
      <circle cx="12.5" cy="14" r="2.25" {...CUT} />
      <path d="m8.5 25 5-5.25 3 3 3.75-4.5L24 23v.5a1.5 1.5 0 0 1-1.5 1.5Z" {...CUT} />
    </Page>
  ),
  pdf: (
    <Page>
      <text x="16" y="24" textAnchor="middle" fontSize="8.5" fontWeight="800" letterSpacing="-0.2" {...CUT}>PDF</text>
    </Page>
  ),
  audio: (
    <Page>
      <path d="M10.5 17.5v4M14 14.5v10M17.5 16.5v6M21 18.5v2" {...LINE} strokeWidth={2.25} />
    </Page>
  ),
  video: (
    <Page>
      <path d="M13.5 15.2a1 1 0 0 1 1.5-.86l5.5 3.3a1 1 0 0 1 0 1.72L15 22.66a1 1 0 0 1-1.5-.86Z" {...CUT} />
    </Page>
  ),
  sheetFile: (
    <Page>
      {[13.5, 19].flatMap((y, row) => [[9.5, 4.5], [15.5, 7]].map(([x, width]) => (
        <rect key={`${x},${y}`} x={x} y={y} width={width} height={4} rx={1.25} {...CUT} fillOpacity={row === 0 ? 1 : 0.55} />
      )))}
    </Page>
  ),
  documentFile: (
    <Page>
      <Bar x={10} y={13} width={12} />
      <Bar x={10} y={18} width={12} faint />
      <Bar x={10} y={23} width={7} faint />
    </Page>
  ),
  slidesFile: (
    <Page>
      <rect x="9.5" y="14" width="13" height="9" rx="2" {...CUT} />
    </Page>
  ),
  archive: (
    <Page>
      <path d="M14 5h2.5M16.5 8.5H14M14 12h2.5M16.5 15.5H14" {...LINE} strokeWidth={2} />
      <rect x="12.75" y="19" width="5" height="6" rx="1.75" {...CUT} />
    </Page>
  ),
  code: (
    <Page>
      <path d="m12.5 15.5-3 3 3 3M19.5 15.5l3 3-3 3" {...LINE} strokeWidth={2.25} />
    </Page>
  ),
  text: (
    <Page>
      <Bar x={10} y={13} width={12} faint />
      <Bar x={10} y={18} width={12} faint />
      <Bar x={10} y={23} width={9} faint />
    </Page>
  ),
} satisfies Record<string, ReactNode>

/** The kinds of thing there is a mark for. */
export type KindMarkName = keyof typeof MARKS

/** Every kind of thing there is a mark for, in the order the gallery shows them. */
export const KIND_MARKS = Object.keys(MARKS) as KindMarkName[]

/**
 * What kind of thing something is — a gadget, a document, a deck, a branch, a PDF — as a solid
 * mark in the language of the workspace's folder and the chat's cloud: a soft silhouette in ink,
 * the page's opposite, with what tells it apart cut out of it or set into it in shade. Sized by
 * what it is in, as a Phosphor icon is (1em unless told), with room around it so that, solid, it
 * weighs the same as an outlined icon beside it.
 */
export const KindMark = ({ name, className }: { name: KindMarkName; className?: string }) => (
  <svg viewBox="-2 -2 36 36" width="1em" height="1em" fill="none" aria-hidden="true" className={cn('shrink-0 text-kumo-inverse', className)}>
    {MARKS[name]}
  </svg>
)
