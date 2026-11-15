import { KindMark, type KindMarkName } from './KindMark'

// Each format's glyph name, as blueprints and the API give it, and the mark it is drawn with.
const MARKS = {
  fileText: 'document',
  gridNine: 'grid',
  presentation: 'presentation',
  appWindow: 'gadget',
  flowArrow: 'flow',
  kanban: 'board',
  chartBar: 'chart',
  table: 'spreadsheet',
  notebook: 'notebook',
  listChecks: 'checklist',
  calendar: 'calendar',
  inbox: 'inbox',
  form: 'form',
  map: 'map',
  dashboard: 'dashboard',
  database: 'database',
  schedule: 'schedule',
  agent: 'agent',
  people: 'people',
  web: 'web',
} satisfies Record<string, KindMarkName>

/** The glyphs an output format (a Document, a Spreadsheet, …) can be drawn with. */
export type FormatIconName = keyof typeof MARKS

/**
 * The mark for an output format (`KindMark`). A name this build does not know draws a gadget's
 * window: a deployment can serve a format newer than the browser's cached bundle.
 */
export const FormatIcon = ({ name, className }: { name?: FormatIconName; className?: string }) => (
  <KindMark name={(name && Object.hasOwn(MARKS, name) ? MARKS[name] : undefined) ?? 'gadget'} className={className} />
)
