import { useState } from 'react'
import { Empty, Input } from '@cloudflare/kumo'
import { MagnifyingGlass, UsersThree } from '@phosphor-icons/react'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { takeLostFocus } from '../lostFocus'
import { SpaceCard } from './SpaceCard'
import { usePublishedSpaces, type PublishedSpacesState } from './usePublishedSpaces'

// A read started from a button disables it, which takes the focus from it, and its result may
// replace the button altogether. So what shows the result takes that focus back: the first card a
// further page adds (the last card, when the final page adds none), or the search box once the
// first page is read again; failing that, the button itself. A hand-off is for the read its button
// started alone: a search typed since, or a session that replaced this one, drops it.
type FocusHandOff = { after: 'more'; firstAdded: number } | { after: 'retry' }

const GRID_CLASS_NAME = 'grid grid-cols-1 gap-3 px-3 sm:grid-cols-2 lg:grid-cols-3'

const spacesCount = (count: number) => `${count} ${count === 1 ? 'space' : 'spaces'}`

const emptyTitle = (query: string) =>
  query === '' ? 'No spaces have published workspaces yet' : 'No spaces match'

// What a screen reader is told once results settle. Silent while a search is under way, so the
// next count is announced even when it is the same as the last one.
const announcement = (state: PublishedSpacesState, searching: boolean) => {
  if (searching || state.status !== 'ready') return ''
  if (state.spaces.length === 0) return emptyTitle(state.query)
  return `${spacesCount(state.spaces.length)}${state.cursor === undefined ? '' : ', more available'}`
}

/**
 * The directory of spaces that publish a workspace to everyone, the user's own among them,
 * searched on the server as the user types and read a page at a time. Each space links to its own
 * page, where a visitor sees what it publishes.
 */
export const SpaceDirectory = () => {
  const [search, setSearch] = useState('')
  const { state, searching, loadMore, refresh } = usePublishedSpaces(search)
  const [handOff, setHandOff] = useState<FocusHandOff | null>(null)
  // Only a first read, which a new session starts, shows `loading`.
  if (handOff !== null && state.status === 'loading') setHandOff(null)

  // Each of these refs is given only once the read it waits for is done, so it is attached, and
  // takes focus that is nowhere, as that result is shown. Refs attach in document order, so a
  // card a page adds is offered the focus before the Load more button below it.
  const retried = handOff?.after === 'retry'
  const moreRead = handOff?.after === 'more' && state.status === 'ready' && state.more !== 'loading'
  const focusedCard = !moreRead ? -1
    : handOff.firstAdded < state.spaces.length ? handOff.firstAdded
    : state.cursor === undefined ? state.spaces.length - 1
    : -1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end px-3 pb-3">
        <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
          <MagnifyingGlass
            aria-hidden="true"
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
          />
          <Input
            ref={retried && state.status === 'ready' ? takeLostFocus : undefined}
            type="search"
            aria-label="Search spaces"
            placeholder="Search spaces…"
            value={search}
            onChange={event => {
              setHandOff(null)
              setSearch(event.target.value)
            }}
            className="w-full pl-9"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </div>
      </div>

      <div className="chat-panel min-h-0 flex-1 overflow-y-auto pb-8 pt-1" aria-busy={searching || state.status === 'loading'}>
        {state.status === 'loading' ? (
          <div aria-hidden="true" className={GRID_CLASS_NAME}>
            {[0, 1, 2, 3, 4, 5].map(index => (
              <div key={index} className="h-[74px] animate-pulse rounded-xl bg-kumo-elevated" />
            ))}
          </div>
        ) : state.status === 'failed' ? (
          <div className="flex flex-col items-center gap-3 px-3 py-20 text-center">
            {/* Emptied while a read is under way, so that a read failing again is announced. */}
            <p role="alert" className="min-h-[18px] text-[13px] leading-[18px] text-kumo-danger">
              {searching ? '' : 'Couldn’t load the spaces.'}
            </p>
            <WorkshopButton
              ref={retried && !searching ? takeLostFocus : undefined}
              loading={searching}
              onClick={() => {
                setHandOff({ after: 'retry' })
                refresh()
              }}
            >
              Try again
            </WorkshopButton>
          </div>
        ) : state.spaces.length === 0 ? (
          <Empty
            icon={<UsersThree size={32} />}
            title={emptyTitle(state.query)}
            description={state.query === ''
              ? 'A space is listed here once a workspace at the top of its tree is published to everyone.'
              : 'Try a different search.'}
          />
        ) : (
          <>
            <ul
              aria-label="Spaces"
              className={`${GRID_CLASS_NAME} transition-opacity duration-150 ${searching ? 'opacity-60' : ''}`}
            >
              {state.spaces.map((space, index) => (
                <li key={space.key} className="min-w-0">
                  <SpaceCard
                    space={space}
                    ref={index === focusedCard ? takeLostFocus : undefined}
                  />
                </li>
              ))}
            </ul>
            {state.cursor !== undefined && (
              <div className="flex flex-col items-center gap-2 px-3 pt-4">
                {state.more === 'failed' && (
                  <p role="alert" className="text-[13px] leading-[18px] text-kumo-danger">
                    Couldn’t load more spaces.
                  </p>
                )}
                <WorkshopButton
                  ref={moreRead ? takeLostFocus : undefined}
                  loading={state.more === 'loading'}
                  onClick={() => {
                    setHandOff({ after: 'more', firstAdded: state.spaces.length })
                    loadMore()
                  }}
                >
                  Load more
                </WorkshopButton>
              </div>
            )}
          </>
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">{announcement(state, searching)}</p>
    </div>
  )
}
