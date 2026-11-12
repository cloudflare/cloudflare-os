import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { OutputListItem } from '@/blocks/OutputListItem'
import { HeaderBubble } from '@/components/HeaderBubble'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { formatActivity } from '@/workspaces/formatActivity'
import { useLibrary } from './useLibrary'

export type LibraryPaneProps = {
  onOpenOutput: (output: OutputSummary) => void
  /** An output's page, for its row to link to so that it can be opened in another tab. */
  outputHref?: (output: OutputSummary) => string
}

const subtitle = ({ output, workspaceTitle, owner, lastActive }: OutputSummary) =>
  [output?.noun ?? 'App', workspaceTitle || 'Untitled workspace', owner && `Shared by ${owner.name}`, formatActivity(lastActive)].filter(Boolean).join(' · ')

/** Everything made in the user's workspaces and those shared with them, each opening as its own page. */
export const LibraryPane = ({ onOpenOutput, outputHref }: LibraryPaneProps) => {
  const library = useLibrary()
  useDocumentTitle('Library')

  return (
    <PageLayout header={<HeaderBubble><h1 className="flex h-9 items-center rounded-full bg-kumo-base px-4 text-base font-medium text-kumo-default ring-1 ring-kumo-line">Library</h1></HeaderBubble>}>
      {library.status === 'loading' && <p role="status" className="px-3 py-2 text-base text-kumo-subtle">Loading the library…</p>}
      {library.status === 'failed' && <p className="px-3 py-2 text-base text-kumo-subtle">Couldn’t load the library: {library.message}</p>}
      {library.status === 'ready' && library.outputs.length === 0 && (
        <p className="px-3 py-2 text-base text-kumo-subtle">Nothing yet. What your chats make shows here.</p>
      )}
      {library.status === 'ready' && library.outputs.length > 0 && (
        <nav aria-label="Library" className="flex flex-col">
          {library.outputs.map((output) => (
            <OutputListItem
              key={`${output.workspaceId}/${output.workpieceId}`}
              title={output.title || 'Untitled'}
              subtitle={subtitle(output)}
              icon={output.output?.icon}
              href={outputHref?.(output)}
              onSelect={() => onOpenOutput(output)}
            />
          ))}
        </nav>
      )}
    </PageLayout>
  )
}
