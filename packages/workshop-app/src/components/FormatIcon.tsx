import {
  AppWindowIcon, ChartUpIcon, CheckListIcon, FileTextIcon, GridTableIcon, KanbanIcon, Notebook02Icon,
  Presentation01Icon, SplineIcon, TableIcon, type Icon, type IconProps,
} from './icons'

const ICONS = {
  fileText: FileTextIcon,
  gridNine: GridTableIcon,
  presentation: Presentation01Icon,
  appWindow: AppWindowIcon,
  flowArrow: SplineIcon,
  kanban: KanbanIcon,
  chartBar: ChartUpIcon,
  table: TableIcon,
  notebook: Notebook02Icon,
  listChecks: CheckListIcon,
} satisfies Record<string, Icon>

/** The glyphs an output format (a Document, a Spreadsheet, …) can be drawn with. */
export type FormatIconName = keyof typeof ICONS

/**
 * The glyph for an output format. A name this build does not know draws the generic app window: a
 * deployment can serve a format newer than the browser's cached bundle.
 */
export const FormatIcon = ({ name, ...props }: { name?: FormatIconName } & IconProps) => {
  const Glyph = (name && Object.hasOwn(ICONS, name) ? ICONS[name] : undefined) ?? AppWindowIcon
  return <Glyph aria-hidden="true" {...props} />
}
