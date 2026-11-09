import { useCallback, useEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { FormatGlyph } from '../../components/format/FormatVisuals'
import { libraryTimeLabel } from '../../features/library/libraryTime'
import { logRpcFailure } from '../../rpcErrors'
import { BlueprintRow, BlueprintsEmpty, matchesQuery } from './blueprintRows'

// One row, merged from the blueprints the user published (listOwnBlueprints) and the ones they
// saved or uploaded (listLibraryBlueprints).
type YourBlueprint = {
  id: string
  title: string
  description: string
  output?: BlueprintOutput
  touched: Date
  starred: boolean
  saved: boolean
  published: boolean
}

const newestFirst = (items: YourBlueprint[]) => items.toSorted((a, b) => b.touched.getTime() - a.touched.getTime())

/**
 * The blueprints the user published or saved, as Library rows: starred ones in a card of their
 * own above the rest, as the Library does.
 */
export const YourBlueprints = ({ query, onBrowseFeatured, onUpload }: {
  query: string
  onBrowseFeatured: () => void
  onUpload: () => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [items, setItems] = useState<YourBlueprint[] | 'loading' | 'failed'>('loading')
  // Only the latest load may write, so a retry never races an earlier one.
  const loads = useRef(0)

  const load = useCallback(() => {
    const load = ++loads.current
    setItems('loading')
    Promise.all([authenticatedApi.listOwnBlueprints(), authenticatedApi.listLibraryBlueprints()]).then(([own, saved]) => {
      if (load !== loads.current) return
      const byId = new Map<string, YourBlueprint>()
      const entry = (id: string) => {
        let item = byId.get(id)
        if (!item) {
          item = { id, title: '', description: '', touched: new Date(0), starred: false, saved: false, published: false }
          byId.set(id, item)
        }
        return item
      }
      for (const b of saved) {
        const item = entry(b.id)
        item.title ||= b.metadata.title
        item.description ||= b.metadata.description
        item.output ??= b.metadata.output
        item.starred ||= b.pinned === true
        if (b.addedAt > item.touched) item.touched = b.addedAt
        item.saved = true
      }
      for (const b of own) {
        const item = entry(b.id)
        item.title = b.title || item.title
        item.description = b.description || item.description
        item.starred ||= b.pinned === true
        if (b.lastUpdated > item.touched) item.touched = b.lastUpdated
        item.published = true
      }
      setItems(newestFirst([...byId.values()]))
    }, err => {
      logRpcFailure('Failed to load blueprints:', err)
      if (load === loads.current) setItems('failed')
    })
  }, [authenticatedApi])

  useEffect(() => {
    load()
    return () => { loads.current++ }
  }, [load])

  const update = (id: string, change: (item: YourBlueprint) => YourBlueprint | null) =>
    setItems(current => typeof current === 'string' ? current
      : current.flatMap(item => item.id === id ? [change(item)].filter(i => i !== null) : [item]))

  // Overlapping setBlueprintPinned calls have no ordering guarantee, so a second click waits.
  const starring = useRef(new Set<string>())
  const toggleStar = async (item: YourBlueprint) => {
    if (starring.current.has(item.id)) return
    starring.current.add(item.id)
    update(item.id, i => ({ ...i, starred: !item.starred }))
    try {
      await authenticatedApi.setBlueprintPinned(item.id, !item.starred)
    } catch (err) {
      logRpcFailure('Failed to star blueprint:', err)
      update(item.id, i => ({ ...i, starred: item.starred }))
      toasts.add({ title: item.starred ? "Couldn't unstar this" : "Couldn't star this", variant: 'error' })
    } finally {
      starring.current.delete(item.id)
    }
  }

  const unsave = async (item: YourBlueprint) => {
    try {
      await authenticatedApi.removeBlueprintFromLibrary(item.id)
      // One the user published stays, as theirs; one they only saved goes.
      update(item.id, i => i.published ? { ...i, saved: false } : null)
      toasts.add({ title: `Removed “${item.title || 'Untitled blueprint'}”` })
    } catch (err) {
      logRpcFailure('Failed to remove blueprint:', err)
      toasts.add({ title: "Couldn't remove the blueprint", variant: 'error' })
    }
  }

  if (items === 'loading') {
    return (
      <div className="flex flex-col gap-1 rounded-[20px] bg-kumo-contrast/[0.03] p-2" aria-busy="true">
        {[1, 2, 3].map(i => <div key={i} className="h-[49px] animate-pulse rounded-[14px] bg-kumo-tint" />)}
      </div>
    )
  }
  if (items === 'failed') {
    return <BlueprintsEmpty message="Your blueprints couldn't be loaded." action={{ label: 'Try again', onClick: load }} />
  }
  if (items.length === 0) {
    return (
      <BlueprintsEmpty
        message="Blueprints you publish, save or upload show up here."
        action={{ label: 'Browse featured', onClick: onBrowseFeatured }}
        secondary={{ label: 'Upload a .gadget', onClick: onUpload }}
      />
    )
  }
  const shown = items.filter(item => matchesQuery(query, item.title, item.description))
  if (shown.length === 0) return <BlueprintsEmpty message="Nothing matches your search." />

  const groups = [shown.filter(item => item.starred), shown.filter(item => !item.starred)]
  return (
    <div className="flex flex-col gap-2.5">
      {groups.filter(group => group.length > 0).map((group, index) => (
        <div key={index} className="flex flex-col rounded-[20px] bg-kumo-contrast/[0.03] p-2">
          {group.map(item => (
            <BlueprintRow
              key={item.id}
              id={item.id}
              title={item.title}
              description={item.description}
              glyph={<FormatGlyph output={item.output} size="md" weight="regular" />}
              when={libraryTimeLabel(item.touched)}
              star={{ starred: item.starred, onToggle: () => void toggleStar(item) }}
              menu={item.saved ? [{ label: 'Remove from Yours', danger: true, onSelect: () => void unsave(item) }] : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
