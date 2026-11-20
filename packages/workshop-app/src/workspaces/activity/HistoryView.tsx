import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ClockCounterClockwiseIcon } from '@phosphor-icons/react'
import { ActivityRow } from '@/blocks/ActivityRow'
import { Button, EmptyState, groupSurface, LinkButton, ListGroup, ListToolbar, NoMatches, useListView } from '@gadgets/ui'
import { activityList, type ActivityItem } from './activityList'
import { activityStatus, activityTitle, outcomeOf } from './activityEntries'
import type { ActivityHistory } from './WorkspaceActivity'

export type HistoryViewProps = {
  viewerId?: string
  history: ActivityHistory
  /** The chat an entry was made in, with its title, where that is known. */
  chatOf: (entry: ActivityItem['entry']) => { id: number; title: string } | undefined
  onOpenChat: (chat: { id: number; title: string }) => void
  chatHref?: (chatId: number) => string
  onLoadOlder: () => void
  /** What it is called, on the line of its search and filters, before them. */
  heading?: ReactNode
  /**
   * Its entries are one card no taller than most of the screen, under the search and filters, its
   * lines scrolling inside it and older ones read as its end is neared: for a log on a page of other
   * things.
   */
  scrolls?: boolean
}

const fullTime = (at: Date) => at.toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

// When an entry was asked for and decided, in full, for its opened row.
const whenOf = (entry: ActivityItem['entry']) => {
  if (entry.type !== 'action') return `${entry.type === 'observation' ? 'Read' : 'Set up'} ${fullTime(entry.createdAt)}`
  const asked = `Asked ${fullTime(entry.createdAt)}`
  if (entry.state === 'pending' || !entry.appliedAt) return asked
  return `${asked} · ${entry.state === 'approved' ? 'approved' : 'denied'} ${fullTime(entry.appliedAt)}`
}

const LINK = 'inline-flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base px-(--control-pad) text-(length:--control-text) font-medium text-kumo-default ring-1 ring-kumo-line hover:bg-kumo-tint'

/**
 * A workspace's activity log, at the bottom of its Settings tab: a record of everything its agents and apps asked to do, read and
 * set up, latest first, a line each as a log has it, which opens in place to what it did and at
 * what, when, and the way to its chat. Searched and filtered as a list is, and read a page at a
 * time. It is there to look something up in; what needs anyone is on the chats.
 */
export const HistoryView = ({ history, viewerId, chatOf, chatHref, onOpenChat, onLoadOlder, heading, scrolls = false }: HistoryViewProps) => {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (key: string) => setOpen((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const items: ActivityItem[] = history.entries.map((entry) => ({ entry, chat: chatOf(entry) }))
  const list = useListView('workspace-activity', activityList(items, viewerId))
  const shown = list.narrow(items)
  const groups = list.arrange(shown)
  // In a card that scrolls, older entries are read as its end comes near, each page once.
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const { read, more, reading, problem } = history
  useEffect(() => {
    const end = endRef.current
    if (!scrolls || !end || !read || !more || reading || problem) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) onLoadOlder()
    }, { root: scrollRef.current, rootMargin: '0px 0px 300px 0px' })
    observer.observe(end)
    return () => observer.disconnect()
  }, [scrolls, read, more, reading, problem, onLoadOlder])

  // Each entry as a line of the log, opening in place.
  const rowOf = ({ entry, chat }: ActivityItem, time: string | undefined) => {
    const outcome = outcomeOf(entry)
    return (
      <ActivityRow
        key={entry.id}
        outcome={outcome}
        title={activityTitle(entry)}
        status={activityStatus(entry, viewerId)}
        time={time}
        resource={entry.resourceTitle ? { title: entry.resourceTitle, url: entry.resourceUrl } : undefined}
        chat={chat?.title}
        open={open.has(`entry:${entry.id}`)}
        onToggle={() => toggle(`entry:${entry.id}`)}
        description={entry.description.description}
        fields={entry.type === 'bindHook' ? [] : entry.description.fields ?? []}
        when={whenOf(entry)}
        links={chat && <LinkButton href={chatHref?.(chat.id)} onClick={() => onOpenChat(chat)} className={LINK}>Open chat</LinkButton>}
      />
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {heading !== undefined || items.length > 0
        ? (
            <div className="flex min-h-(--control-size) items-center gap-2">
              {heading}
              {items.length > 0 && <ListToolbar noun="the activity log" search={list.controls.search} filter={list.controls.filter} inline={heading !== undefined} />}
            </div>
          )
        : null}
      {!history.read && !history.problem && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the activity log…</p>}
      {history.read && items.length === 0 && !history.more && (
        <EmptyState
          size="section"
          tinted
          icon={ClockCounterClockwiseIcon}
          title="Nothing has happened yet"
          description="What the agents and apps here ask to do, read and set up is listed here."
        />
      )}
      {items.length > 0 && shown.length === 0 && <NoMatches onShowAll={list.showAll} />}
      {scrolls
        ? groups.length > 0 && (
            // One card, its surface still where it is, its lines scrolling within it.
            <div className={cn('flex max-h-[min(36rem,70dvh)] flex-col overflow-hidden rounded-3xl', groupSurface(false))}>
              <div ref={scrollRef} className="min-h-0 overflow-y-auto overscroll-contain">
                <ListGroup label="Activity log" bare>
                  {groups.flatMap(({ entries }) => entries.map(({ value, time }) => rowOf(value, time)))}
                  {reading && read && <p role="status" className="px-3 py-2 text-center text-sm text-kumo-subtle">Loading…</p>}
                  <div ref={endRef} aria-hidden="true" className="h-px shrink-0" />
                </ListGroup>
              </div>
            </div>
          )
        : groups.map(({ key, entries }) => (
            <ListGroup key={key} label="Activity log">
              {entries.map(({ value, time }) => rowOf(value, time))}
            </ListGroup>
          ))}
      {history.problem && (
        <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
          Couldn’t load history: {history.problem}
          <Button variant="ghost" onClick={onLoadOlder}>Try again</Button>
        </p>
      )}
      {!scrolls && history.read && history.more && !history.problem && (
        <div className="flex justify-center">
          <Button disabled={history.reading} onClick={onLoadOlder}>{history.reading ? 'Loading…' : 'Load older'}</Button>
        </div>
      )}
    </div>
  )
}
