import { KindMark, type KindMarkName } from './KindMark'
import type { WorkspaceColor } from './workspaceLook'

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
export const FormatIcon = ({ name, color, className }: { name?: FormatIconName; color?: WorkspaceColor; className?: string }) => (
  <KindMark name={(name && Object.hasOwn(MARKS, name) ? MARKS[name] : undefined) ?? 'gadget'} color={color} className={className} />
)

/**
 * The glyphs a gadget can be given, in the order they are offered, each named for whoever cannot
 * see it; that name is also what a gadget given it is called, until it is called something else
 * (`plural`, where adding an "s" would not say several).
 */
export const GADGET_ICONS: { name: FormatIconName; label: string; plural?: string }[] = [
  { name: 'appWindow', label: 'App' },
  { name: 'fileText', label: 'Document' },
  { name: 'table', label: 'Table' },
  { name: 'gridNine', label: 'Grid' },
  { name: 'presentation', label: 'Slides', plural: 'Slides' },
  { name: 'chartBar', label: 'Chart' },
  { name: 'kanban', label: 'Board' },
  { name: 'listChecks', label: 'Checklist' },
  { name: 'notebook', label: 'Notebook' },
  { name: 'flowArrow', label: 'Flow' },
  { name: 'calendar', label: 'Calendar' },
  { name: 'inbox', label: 'Inbox', plural: 'Inboxes' },
  { name: 'form', label: 'Form' },
  { name: 'map', label: 'Map' },
  { name: 'dashboard', label: 'Dashboard' },
  { name: 'database', label: 'Database' },
  { name: 'schedule', label: 'Schedule' },
  { name: 'agent', label: 'Agent' },
  { name: 'people', label: 'People', plural: 'People' },
  { name: 'web', label: 'Website' },
]
