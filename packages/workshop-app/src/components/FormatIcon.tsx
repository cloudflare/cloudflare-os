import {
  AppWindowIcon, ChartBarIcon, FileTextIcon, FlowArrowIcon, GridNineIcon, KanbanIcon, ListChecksIcon,
  NotebookIcon, PresentationIcon, TableIcon, type Icon, type IconProps,
} from '@phosphor-icons/react'

const ICONS = {
  fileText: FileTextIcon,
  gridNine: GridNineIcon,
  presentation: PresentationIcon,
  appWindow: AppWindowIcon,
  flowArrow: FlowArrowIcon,
  kanban: KanbanIcon,
  chartBar: ChartBarIcon,
  table: TableIcon,
  notebook: NotebookIcon,
  listChecks: ListChecksIcon,
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
