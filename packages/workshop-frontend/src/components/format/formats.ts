// How an output format is drawn: which glyph, which nouns, which wireframe. The server sends a
// blueprint's `BlueprintOutput` declaration; this module is the only place that maps it to pixels.
//
// Icons are a closed set (`OUTPUT_ICONS` in the shared API) so a free-form name can't make a
// deployment look wrong. Only the key crosses the wire; the glyphs live here.

import {
  FileText,
  GridNine,
  Presentation,
  AppWindow,
  FlowArrow,
  Kanban,
  ChartBar,
  Table,
  Notebook,
  ListChecks,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react'
import type { BlueprintOutput, OutputIcon } from '@gadgets/workshop-shared/api'

/** The glyph for each key in the shared `OUTPUT_ICONS` vocabulary. */
export const FORMAT_ICONS = {
  fileText: FileText,
  gridNine: GridNine,
  presentation: Presentation,
  appWindow: AppWindow,
  flowArrow: FlowArrow,
  kanban: Kanban,
  chartBar: ChartBar,
  table: Table,
  notebook: Notebook,
  listChecks: ListChecks,
} satisfies Record<OutputIcon, PhosphorIcon>

/**
 * Which wireframe illustrates a format. Derived from the icon rather than picked separately, so
 * the two can't disagree; icons depicting the same artefact (a page vs. a notebook) share one.
 */
export type FormatWireframe = 'page' | 'grid' | 'slide' | 'window' | 'list' | 'board' | 'chart'

const WIREFRAME_FOR_ICON: Record<OutputIcon, FormatWireframe> = {
  fileText: 'page',
  notebook: 'page',
  gridNine: 'grid',
  table: 'grid',
  presentation: 'slide',
  chartBar: 'chart',
  appWindow: 'window',
  flowArrow: 'board',
  kanban: 'board',
  listChecks: 'list',
}

/**
 * How a gadget with no declared format is shown. Also the fallback for an icon this build doesn't
 * know, which is normal: a deployment can serve a format newer than the browser's cached bundle.
 */
export const GENERIC_OUTPUT: BlueprintOutput = {
  id: 'app',
  noun: 'App',
  plural: 'Apps',
  icon: 'appWindow',
}

/** Resolve what to draw for a (possibly absent, possibly unrecognized) declared format. */
export function formatOf(output?: BlueprintOutput): BlueprintOutput {
  if (!output || !Object.hasOwn(FORMAT_ICONS, output.icon)) return GENERIC_OUTPUT
  return output
}

export function wireframeOf(output?: BlueprintOutput): FormatWireframe {
  return WIREFRAME_FOR_ICON[formatOf(output).icon]
}
