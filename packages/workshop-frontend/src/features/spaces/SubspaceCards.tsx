import { useRef, useState } from 'react'
import { BusyButton } from './BusyButton'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { SPACE_CARD_GRID_CLASS_NAME, SpaceCard } from './SpaceCard'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import type { SubspaceListing } from './useSubspaces'

/**
 * The sub-spaces directly inside a space, as cards. Nothing while they are being read and
 * nothing for a space that has none, so a space with no sub-space shows no empty section; when
 * they could not be read it says so, with a way to read them again.
 */
export const SubspaceCards = ({ label, listing, onMembersOpen, onReload, onFocusLost }: {
  /** What the space they are inside is called here, which names the list and its `Try again`. */
  label: string
  /** The space's sub-spaces as last read (`useSubspaces`, or a space page's `useSpaceContents`). */
  listing: SubspaceListing
  /** The user asked for the members of the sub-space with this id. */
  onMembersOpen: (spaceId: string) => void
  /** Reads the sub-spaces again, resolving once the read has settled either way. */
  onReload: () => Promise<void>
  /**
   * `Try again` went, the read having found no sub-space, and nothing of this component is left
   * to take the focus it had.
   */
  onFocusLost: () => void
}) => {
  const listRef = useRef<HTMLUListElement>(null)
  const [reloading, setReloading] = useState(false)
  // `Try again` goes once the sub-spaces have been read, and the first card's link takes the
  // focus it had. The caller is asked to place it only when the read brought no card: what the
  // caller has for it, a search field or a control of the page's head, is further from where
  // the focus was. A read that failed leaves `Try again` where it is, with the focus.
  const reloadSettled = useFocusAfterAction(() => {
    const firstLink = listRef.current?.querySelector('a')
    if (firstLink) takeLostFocus(firstLink)
    else if (listing.status !== 'failed') onFocusLost()
  })

  const reload = async () => {
    setReloading(true)
    try {
      await onReload()
    } finally {
      setReloading(false)
      reloadSettled()
    }
  }

  if (listing.status === 'failed') {
    return (
      <div role="alert" className="flex shrink-0 items-center gap-3 px-3 pb-3">
        <p className="text-[13px] leading-[18px] text-kumo-danger">
          Couldn’t load the sub-spaces of {label}.
        </p>
        <BusyButton
          className={SPACE_ACTION_CLASS_NAME}
          aria-label={`Try again to load the sub-spaces of ${label}`}
          busy={reloading}
          onClick={() => void reload()}
        >
          Try again
        </BusyButton>
      </div>
    )
  }
  // A space that refuses the user is its page's to show, whose own read of it is refused too.
  if (listing.status !== 'ready' || listing.subspaces.length === 0) return null
  return (
    <ul
      ref={listRef}
      aria-label={`Sub-spaces of ${label}`}
      className={`${SPACE_CARD_GRID_CLASS_NAME} shrink-0 pb-3`}
    >
      {listing.subspaces.map(subspace => (
        <SpaceCard key={subspace.id} subspace={subspace} onMembersOpen={onMembersOpen} />
      ))}
    </ul>
  )
}
