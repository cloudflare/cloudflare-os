import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { SearchEntry } from '@/blocks/SearchDialog'
import { FormatIcon } from '@/components/FormatIcon'

/**
 * Search's way to what the user has made: an entry for each output the library lists, most recently
 * active first as it is given, titled as the library titles it, with the workspace it is in at its
 * end, as titles repeat, and found by what kind it is ("app", "document"). Choosing one hands it to
 * `onOpen`, which is to go to its own page. Found by typing only: none is offered before that.
 */
export const libraryEntries = (outputs: readonly OutputSummary[], onOpen: (output: OutputSummary) => void): SearchEntry[] =>
  outputs.map((output) => ({
    key: `library:${output.workspaceId}:${output.workpieceId}`,
    group: 'Library',
    title: output.title || 'Untitled',
    // What a listed output with no format is: an app.
    keywords: [output.output?.noun ?? 'app'],
    detail: output.workspaceTitle || 'Untitled workspace',
    icon: <FormatIcon name={output.output?.icon} />,
    onSelect: () => onOpen(output),
  }))
