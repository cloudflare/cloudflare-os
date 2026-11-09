import { useState } from 'react'
import { BusyButton } from './BusyButton'
import { useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import type { SpaceListing } from './useSpaceListings'

/**
 * What a team space's page says while what the space lists is not on show: that it is being
 * read, that the space refused the user, or that the read failed, with a way to read it again.
 * Nothing once the listing has been read.
 */
export const SpaceListingStatus = ({ status, label, onReload, onFocusLost }: {
  status: SpaceListing['status']
  /** The space's name, which names its `Try again`. */
  label: string
  /** Reads the listing again, resolving once the read has settled either way. */
  onReload: () => Promise<void>
  /** `Try again` went, the read having worked, and the focus it had went with it. */
  onFocusLost: () => void
}) => {
  const [reloading, setReloading] = useState(false)
  const reloadSettled = useFocusAfterAction(onFocusLost)

  const reload = async () => {
    setReloading(true)
    try {
      await onReload()
    } finally {
      setReloading(false)
      reloadSettled()
    }
  }

  switch (status) {
    case 'loading':
      return (
        <p role="status" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-inactive">
          Loading this space’s workspaces…
        </p>
      )
    case 'refused':
      return (
        <p role="alert" className="px-3 py-2 text-[13px] leading-[18px] text-kumo-default">
          You are no longer a member of this space.
        </p>
      )
    case 'failed':
      return (
        <div role="alert" className="flex items-center gap-3 px-3 py-2">
          <p className="text-[13px] leading-[18px] text-kumo-danger">
            Couldn’t load this space’s workspaces.
          </p>
          <BusyButton
            className={SPACE_ACTION_CLASS_NAME}
            aria-label={`Try again to load ${label}`}
            busy={reloading}
            onClick={() => void reload()}
          >
            Try again
          </BusyButton>
        </div>
      )
    case 'ready':
      return null
  }
}
