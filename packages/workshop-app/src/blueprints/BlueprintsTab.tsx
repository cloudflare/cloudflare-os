import { useState } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, BookmarkSimpleIcon, LinkIcon, MinusCircleIcon, SparkleIcon, TrashIcon } from '@phosphor-icons/react'
import { BlueprintTile } from '@/blocks/BlueprintTile'
import type { LibraryAction } from '@/blocks/LibraryRow'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { FormatIcon } from '@/components/FormatIcon'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { blueprintDetail, blueprintGroups, type BlueprintEntry } from './blueprintEntries'
import { useBlueprints } from './useBlueprints'

export type BlueprintsTabProps = {
  sort: 'recent' | 'name'
  query: string
  onOpen: (blueprintId: string) => void
  /** Opens its page with Use already asked for. */
  onUse: (blueprintId: string) => void
  /** Its page, for its tile to link to so that it can be opened in another tab. */
  href?: (blueprintId: string) => string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/**
 * The Library's Blueprints tab: gadgets published for anyone to start their own from, as tiles
 * with their pictures. Those the deployment features first, then the user's own, published or
 * saved. Each opens as its own page; its menu uses it, saves it or takes it out. Search and the
 * order are the Library's.
 */
export const BlueprintsTab = ({ sort, query, onOpen, onUse, href }: BlueprintsTabProps) => {
  const { state, setSaved } = useBlueprints()
  const connection = useConnectionNotice()
  const [problem, setProblem] = useState<string>()
  const [deleting, setDeleting] = useState<BlueprintEntry>()
  // The one being asked about, kept while the dialog closes so its words do not change as it goes.
  const [asked, setAsked] = useState<BlueprintEntry>()

  if (state.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading blueprints…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
        Couldn’t load blueprints: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }

  const act = (doing: string, run: () => Promise<unknown>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${doing}: ${messageOf(error)}`))
  }

  const actionsOf = (entry: BlueprintEntry): LibraryAction[] => {
    const address = href?.(entry.id)
    return [
      { key: 'open', label: 'Open', icon: ArrowUpRightIcon, onSelect: () => onOpen(entry.id) },
      { key: 'use', label: 'Use blueprint…', icon: SparkleIcon, onSelect: () => onUse(entry.id) },
      ...(address
        ? [
            { key: 'tab', label: 'Open in new tab', icon: ArrowSquareOutIcon, onSelect: () => window.open(address, '_blank', 'noopener') },
            { key: 'link', label: 'Copy link', icon: LinkIcon, onSelect: () => copyLink(address) },
          ]
        : []),
      // The user's own is theirs already; one they uploaded goes from storage with its entry.
      ...(entry.published
        ? []
        : entry.saved?.uploaded
          ? [{ key: 'delete', label: 'Delete blueprint…', icon: TrashIcon, onSelect: () => { setDeleting(entry); setAsked(entry) } }]
          : entry.saved
            ? [{ key: 'unsave', label: 'Remove from Library', icon: MinusCircleIcon, onSelect: () => act('take it out', () => setSaved(entry.id, false)) }]
            : [{ key: 'save', label: 'Save to Library', icon: BookmarkSimpleIcon, onSelect: () => act('save it', () => setSaved(entry.id, true)) }]),
    ]
  }

  const groups = blueprintGroups(state.entries, { sort, query })
  return (
    <>
      {problem && <p role="alert" className="px-4 text-base text-kumo-subtle">{problem}</p>}
      {groups.length === 0 && (
        <p className="appears px-4 text-center text-base text-pretty text-kumo-subtle">
          {query.trim()
            ? `No blueprint is called “${query.trim()}”.`
            : 'No blueprints yet. A blueprint is a gadget published for anyone to start their own from: publish one from a gadget’s settings, and it shows here.'}
        </p>
      )}
      {groups.map(({ key, label, entries }) => (
        <section key={key} aria-label={label} className="appears flex flex-col gap-3">
          <h2 className="px-1 text-sm font-medium text-kumo-subtle">{label}</h2>
          <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3">
            {entries.map((entry) => (
              <BlueprintTile
                key={entry.id}
                title={entry.title}
                detail={blueprintDetail(entry)}
                picture={entry.picture}
                icon={<FormatIcon name={entry.output?.icon} />}
                label={entry.output?.noun ?? 'App'}
                badge={key === 'featured' && entry.saved ? 'Saved' : undefined}
                actions={actionsOf(entry)}
                href={href?.(entry.id)}
                onSelect={() => onOpen(entry.id)}
              />
            ))}
          </div>
        </section>
      ))}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => { if (!open) setDeleting(undefined) }}
        destructive
        title={`Delete “${asked?.title ?? 'this blueprint'}”?`}
        description="You uploaded it, so it goes for good, for anyone it was shared with. Gadgets already made from it stay. This can’t be undone."
        confirm="Delete blueprint"
        onConfirm={async () => {
          if (!asked || connection?.blocked()) return false
          await setSaved(asked.id, false)
          return true
        }}
      />
    </>
  )
}
