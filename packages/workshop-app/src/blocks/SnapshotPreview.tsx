import { useState, type Ref } from 'react'
import { CollapseIcon, FileDownIcon, FullScreenIcon, MoreHorizontalIcon, RedoIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { Button, DropdownMenu } from '@gadgets/ui'
import { ExportItems, type ExportItemsProps } from './ExportItems'
import { GadgetFrame } from './GadgetFrame'

export type SnapshotPreviewProps = {
  /** What the gadget is, as its frame's accessible name. */
  gadgetTitle: string
  /** What whoever views it is shown over it: the workspace it is in, and whose it is. */
  workspaceTitle: string
  /** Left out where it is the viewer's own. */
  ownerName?: string
  /**
   * The snapshot, as far as it has got: being taken, the page it runs in (`load` different each
   * time it is taken again, so that its frame starts over), or why there is none to show.
   */
  snapshot: { status: 'loading' } | { status: 'failed' } | { status: 'none' } | { status: 'ready'; page: string; load: number }
  /** The frame it is shown in, for whoever connects its page. */
  frame?: Ref<HTMLIFrameElement>
  /** Takes it again, as it is now; rejects with nothing to say, `problem` saying why. */
  onRefresh: () => Promise<void>
  /** Why it could not be taken again. */
  problem?: string
  /** What it can be exported as (`ExportItems`), as whoever views it can. */
  exports?: ExportItemsProps
  /** Whether it is given all the room there is, by whatever holds it, to be looked at closely. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}

// The gadget is drawn at this much of its size, in a frame as wide as a screen is to its height,
// so that what was laid out for a window reads as itself in the little room a dialog has.
const SCALE = 0.6

const BAR_BUTTON = 'text-kumo-subtle hover:text-kumo-default'

/**
 * What someone who may only view a gadget opens: its snapshot, alive, as they will have it, under
 * the bar they will have over it, which names the workspace and whose it is, takes the snapshot
 * again and exports it, under More, and gives it more room. Small, it is drawn at a part of its size, as a window
 * would show it; given room, at its own. It is the same frame either way, so that what was done in
 * it carries over. It gives way before what holds it scrolls: its stage is as short as the room left.
 */
export const SnapshotPreview = ({ gadgetTitle, workspaceTitle, ownerName, snapshot, frame, onRefresh, problem, exports, expanded, onExpandedChange }: SnapshotPreviewProps) => {
  const [refreshing, setRefreshing] = useState(false)
  const ready = snapshot.status === 'ready'

  const refresh = () => {
    setRefreshing(true)
    onRefresh().catch(() => {}).finally(() => setRefreshing(false))
  }

  return (
    <div className="flex min-h-40 shrink flex-col gap-2">
      <div className="flex min-h-0 flex-col overflow-hidden rounded-(--surface-radius) bg-kumo-base ring-1 ring-kumo-line">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-kumo-line ps-4 pe-1.5">
          {/* On one line of text, so that the two sizes sit on it together. */}
          <p className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate font-medium text-kumo-default">{workspaceTitle}</span>
            {ownerName && <span className="shrink-0 text-sm text-kumo-subtle">by {ownerName}</span>}
          </p>
          {/* As a gadget's own pane has them (`SidePane`): what can be done with it under More, and
              the room it is given beside that. There from the start, so that nothing arrives in
              the bar once the snapshot has. */}
          <div className="flex shrink-0 items-center">
            <DropdownMenu icon={MoreHorizontalIcon} aria-label={`More for the snapshot of ${gadgetTitle}`} triggerVariant="ghost" triggerClassName={BAR_BUTTON} align="end">
              <DropdownMenu.Item icon={RedoIcon} disabled={!ready || refreshing} onSelect={refresh}>Refresh snapshot</DropdownMenu.Item>
              {exports && ready && (
                // Its items are only there while it is open, so that each opening reads what there is again.
                <DropdownMenu.Submenu label="Export snapshot" icon={FileDownIcon}>
                  <ExportItems {...exports} />
                </DropdownMenu.Submenu>
              )}
            </DropdownMenu>
            {expanded
              ? <Button variant="ghost" icon={CollapseIcon} aria-label="Collapse" title="Collapse" onClick={() => onExpandedChange(false)} className={BAR_BUTTON} />
              : <Button variant="ghost" icon={FullScreenIcon} aria-label="Expand" title="Expand" onClick={() => onExpandedChange(true)} className={BAR_BUTTON} />}
          </div>
        </div>
        <div aria-busy={refreshing || undefined} className={cn('relative min-h-0 overflow-hidden bg-kumo-base transition-opacity motion-reduce:transition-none', refreshing && 'opacity-50', expanded ? 'h-[calc(100dvh-21rem)]' : 'aspect-video')}>
          {ready ? (
            <div
              className="absolute top-0 left-0 flex origin-top-left flex-col"
              style={expanded ? { width: '100%', height: '100%' } : { width: `${100 / SCALE}%`, height: `${100 / SCALE}%`, transform: `scale(${SCALE})` }}
            >
              <GadgetFrame key={snapshot.load} ref={frame} page={snapshot.page} title={`Snapshot of ${gadgetTitle}`} />
            </div>
          ) : (
            <p role={snapshot.status === 'loading' ? 'status' : 'alert'} className={cn('absolute inset-0 grid place-items-center px-6 text-center text-sm text-kumo-subtle', snapshot.status === 'loading' && 'appears-late')}>
              {snapshot.status === 'loading' ? 'Taking a snapshot…' : snapshot.status === 'none' ? 'This gadget has nothing to show yet.' : 'Couldn’t load a preview.'}
            </p>
          )}
        </div>
      </div>
      {problem && <p role="alert" className="px-1 text-sm text-kumo-danger">{problem}</p>}
    </div>
  )
}
