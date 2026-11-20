import { useState } from 'react'
import type { AiChatAuthorInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { ChatsCircleIcon, EyeIcon, NotePencilIcon, QuestionIcon, ShieldCheckIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { isAgentRun } from '@/automations/agents'
import { ChatListItem, type ChatBadge } from '@/blocks/ChatListItem'
import { ListGroup } from '@/blocks/ListGroup'
import { ListToolbar } from '@/blocks/ListToolbar'
import { NoMatches } from '@/blocks/NoMatches'
import type { StatusPillProps } from '@/blocks/StatusPill'
import { Button } from '@/components/Button'
import { EmptyState } from '@/components/EmptyState'
import { useListView } from '@/hooks/useListView'
import type { LatestMessage } from './activity/WorkspaceActivity'
import { favoritesFirst, groupChats, ownerOf } from './chatGroups'
import { chatList, chatTitle, type ChatGrouping } from './chatList'
import { chatByOf, speakerOf, type ChatState } from './chatStates'
import { formatActivity, formatActivityShort } from './formatActivity'

export type ChatListViewProps = {
  status: { status: 'loading' } | { status: 'failed'; message: string } | { status: 'ready' }
  /** Every chat, people's and agents' runs alike. */
  chats: readonly AiChatMetadata[]
  /** How each chat in progress stands, by its id (`chatStatesOf`). */
  states: ReadonlyMap<number, ChatState>
  unreadOf: (chatId: number) => number
  /** Who started each chat, by its id, where known, and the start of its latest message (the inbox's, for one unread). */
  starters: ReadonlyMap<number, AiChatAuthorInfo>
  latest: ReadonlyMap<number, Pick<LatestMessage, 'text' | 'author' | 'at'>>
  /** What each chat last asked of a person (`WorkspaceActivity`'s `asks`), said in place of its latest message while it waits on it. */
  asks?: ReadonlyMap<number, Pick<LatestMessage, 'text' | 'author' | 'at'>>
  previews: ReadonlyMap<number, { preview?: string }>
  favorites: { has: (chatId: number) => boolean; toggle: (chatId: number) => void }
  viewerId?: string
  /** Each chat's cost is shown, and they can be ordered by it. */
  showsCost?: boolean
  /** The chats waiting on a person besides those `states` says, by id. */
  waiting?: ReadonlySet<number>
  onOpenChat: (chat: { id: number; title: string }) => void
  chatHref?: (chatId: number) => string
  onMarkRead?: () => Promise<void>
  onNewChat: () => void
}

type RunsShown = 'needing' | 'all' | 'none'
const RUNS_SHOWN: Array<{ id: RunsShown; label: string }> = [
  { id: 'needing', label: 'Action needed' },
  { id: 'all', label: 'All' },
  { id: 'none', label: 'None' },
]

// Ready for review holds nobody up: its words say it, with no mark.
const BADGES: Record<ChatState['kind'], ChatBadge | undefined> = { approval: 'waiting', answer: 'waiting', failed: 'failed', review: undefined, working: 'working' }
// At work, it says so under its title, in place of its latest message, and needs no pill.
// On a narrow screen, an icon in place of the words.
const PILLS: Record<Exclude<ChatState['kind'], 'working'>, Pick<StatusPillProps, 'tone' | 'icon'>> = {
  approval: { tone: 'warning', icon: ShieldCheckIcon },
  answer: { tone: 'warning', icon: QuestionIcon },
  failed: { tone: 'danger', icon: WarningCircleIcon },
  review: { tone: 'info', icon: EyeIcon },
}

/**
 * A workspace's chats, people's and its agents' runs alike, each by who it is by. The viewer's
 * favorites first, whatever the grouping; then in groups (`groupChats`): by how they stand, most
 * urgent first, told apart by what is in them rather than headed (waiting on an approval or an
 * answer, failed, ready for review, unread, the rest; what is at work stays where it would be, saying so), unless they are grouped by date or
 * by owner, under headings, or not at all; each group in the order chosen, the latest first unless
 * another is. An agent's run is
 * only listed while it needs someone or is starred, unless a search looks for it or the filters
 * ask for all of them (Agent runs: Action needed, All, None). Each row says how it stands, or its latest message. Over
 * them, a search, the grouping and the order, the filters, marking all read, and a new chat.
 */
export const ChatListView = (props: ChatListViewProps) => {
  const { status, chats: all, states, unreadOf: unreadCount, starters, latest: latestOf, asks = new Map(), previews, favorites, viewerId, showsCost = false, waiting, onOpenChat, chatHref, onMarkRead, onNewChat } = props
  const unreadOf = ({ id }: { id: number }) => unreadCount(id)
  const unreadIds = all.filter((chat) => unreadOf(chat) > 0).map(({ id }) => id)
  // What needs the viewer, the same here as in the first group, the pills and the filter.
  const needsYou = ({ id, awaitingDecision }: { id: number; awaitingDecision?: true }) => {
    const kind = states.get(id)?.kind
    return waiting?.has(id) || awaitingDecision === true || (kind !== undefined && kind !== 'working')
  }
  const isFavorite = ({ id }: { id: number }) => favorites.has(id)
  const isMine = (chat: AiChatMetadata) => !isAgentRun(chat) && viewerId !== undefined && starters.get(chat.id)?.id === viewerId
  const list = useListView('workspace-chats', chatList(new Set(unreadIds), needsYou, showsCost, { favorite: isFavorite, mine: isMine }))
  // Which of agents' runs are listed: those that need the viewer or are starred (and any a search
  // finds), all of them, or none.
  const [runs, setRuns] = useState<RunsShown>('needing')
  const quiet = (chat: AiChatMetadata) => isAgentRun(chat) && !needsYou(chat) && !isFavorite(chat)
  const found = list.narrow([...all])
  const searching = list.controls.search.value.trim() !== ''
  const shown = runs === 'none' ? found.filter((chat) => !isAgentRun(chat)) : runs === 'needing' && !searching ? found.filter((chat) => !quiet(chat)) : found
  // The order chosen, then the grouping, each group in that order.
  const grouping = (list.grouping ?? 'status') as ChatGrouping
  const arrange = (chats: AiChatMetadata[]) => groupChats(grouping, list.arrange(chats).flatMap(({ entries }) => entries.map(({ value }) => value)), {
    states,
    unread: (id) => unreadIds.includes(id),
    owner: (chat) => ownerOf(chat, starters.get(chat.id), viewerId),
    // By when it started, where that is the order.
    at: (chat) => (list.order.id === 'started' ? chat.started : chat.lastActive),
  })
  const headed = arrange([]).headed
  const groups = favoritesFirst(shown, isFavorite, (chats) => arrange(chats).groups)

  const [markProblem, setMarkProblem] = useState<string>()
  const markRead = onMarkRead && unreadIds.length > 0
    ? () => {
      setMarkProblem(undefined)
      onMarkRead().catch((error: unknown) => setMarkProblem(`Couldn’t mark it read: ${error instanceof Error ? error.message : String(error)}`))
    }
    : undefined

  const row = (chat: AiChatMetadata) => {
    const state = states.get(chat.id)
    const unread = unreadOf(chat)
    // While it waits on an approval or an answer, what it asks, where it asked it after it last said anything.
    const ask = state?.kind === 'approval' || state?.kind === 'answer' ? asks.get(chat.id) : undefined
    const said = latestOf.get(chat.id)
    const latest = ask && (!said || ask.at >= said.at) ? ask : said
    const preview = unread > 0 ? previews.get(chat.id)?.preview : undefined
    return (
      <ChatListItem
        key={chat.id}
        title={chatTitle(chat)}
        time={formatActivity(chat.lastActive, undefined, { ago: false })}
        shortTime={formatActivityShort(chat.lastActive)}
        unread={unread}
        by={chatByOf(chat, starters.get(chat.id), viewerId)}
        // Two lines always, so that a row does not grow as what it said is read.
        detail={state?.kind === 'working'
          ? { words: state.words, working: true }
          : latest
            ? { words: latest.text, speaker: speakerOf(chat, latest.author, viewerId) }
            // Its messages not read yet, a run still says whose it is.
            : { words: preview ?? (isAgentRun(chat) ? chat.spawnerName ?? '' : '') }}
        status={state && state.kind !== 'working' ? { words: state.words, ...PILLS[state.kind] } : undefined}
        badge={state ? BADGES[state.kind] : undefined}
        favorite={{ on: favorites.has(chat.id), onToggle: () => favorites.toggle(chat.id) }}
        cost={showsCost ? chat.totalCost : undefined}
        href={chatHref?.(chat.id)}
        onSelect={() => onOpenChat({ id: chat.id, title: chat.title })}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* None with no chats, where the empty state has the way to start one. */}
      {!(status.status === 'ready' && all.length === 0) && (
        <ListToolbar
          noun="chats"
          {...(all.length > 0
            ? {
              search: list.controls.search,
              order: list.controls.order,
              filter: {
                ...list.controls.filter,
                choices: [{ id: 'runs', label: 'Agent runs', options: RUNS_SHOWN, value: runs, default: 'needing', onChange: (id) => setRuns(id as RunsShown) }],
              },
            }
            : {})}
          action={(
            <span className="flex gap-2">
              {markRead && <Button variant="ghost" onClick={markRead}>Mark all read</Button>}
              <Button variant="primary" icon={NotePencilIcon} onClick={onNewChat}>New chat</Button>
            </span>
          )}
        />
      )}
      {markProblem && <p role="alert" className="px-4 text-center text-base text-kumo-danger">{markProblem}</p>}
      {status.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading chats…</p>}
      {status.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load chats: {status.message}</p>}
      {status.status === 'ready' && all.length === 0 && (
        <EmptyState
          size="section"
          tinted
          icon={ChatsCircleIcon}
          title="No chats yet"
          description="Chats in this workspace show here. Ask for an app, a document or something to run by itself, and it’s made here."
          actions={[{ label: 'New chat', icon: NotePencilIcon, variant: 'primary', onClick: onNewChat }]}
        />
      )}
      {(list.narrowed || runs !== 'needing') && shown.length === 0 && (
        <NoMatches
          noun="chats"
          onShowAll={() => {
            list.showAll()
            setRuns('needing')
          }}
        />
      )}
      {/* Another order or grouping is another list, cut to rather than moved to row by row. */}
      <div key={`${grouping}:${list.order.id}`} className={cn('flex flex-col', headed ? 'gap-6' : 'gap-3')}>
        {groups.map(({ key, label, entries }) => {
          const group = <ListGroup key={key} label={label}>{entries.map(({ value }) => row(value))}</ListGroup>
          return headed
            ? (
              <section key={key} className="flex flex-col gap-2">
                <h2 className="px-4 text-sm font-medium text-kumo-subtle">{label}</h2>
                {group}
              </section>
            )
            : group
        })}
      </div>
    </div>
  )
}
