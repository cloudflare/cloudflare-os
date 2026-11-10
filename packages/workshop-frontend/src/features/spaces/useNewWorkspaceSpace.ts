import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { useSpaces } from './useSpaces'

/**
 * The space a new workspace is created in, for a screen that lets the user pick it.
 *
 * `spaceId` is a team space's id, or null for the user's personal space. It starts as `preset`
 * (the `space` search parameter of a link that asks for a space) and follows the user's choice
 * once they make one; either counts only while it names one of `teamSpaces`, the team spaces the
 * user is a member of, so it is null until that list has loaded and while the `spaces` flag is
 * off.
 */
export const useNewWorkspaceSpace = (preset: string | undefined): {
  teamSpaces: SpaceInfo[]
  spaceId: string | null
  chooseSpace: (spaceId: string | null) => void
  /**
   * Resolves once `spaceId` no longer waits on anything: at once, unless a preset is still to be
   * told from the `spaces` flag and the list of spaces whether it counts. What sends a workspace's
   * first message awaits it, so a link that asks for a space is honoured however early that is.
   */
  whenSettled: () => Promise<void>
} => {
  const flag = useUiFeatureFlag('spaces')
  const spaces = useSpaces()
  const teamSpaces = spaces.spaces.filter(space => space.kind === 'team')
  // Undefined until the user chooses.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined)
  const wanted = chosen === undefined ? preset : chosen

  const presetPending = chosen === undefined && preset !== undefined && (flag.loading || spaces.loading)
  const presetPendingRef = useRef(presetPending)
  presetPendingRef.current = presetPending
  const waiting = useRef<Array<() => void>>([])
  useEffect(() => {
    if (presetPending) return
    for (const resolve of waiting.current.splice(0)) resolve()
  }, [presetPending])
  const whenSettled = useCallback(() => (presetPendingRef.current
    ? new Promise<void>((resolve) => { waiting.current.push(resolve) })
    : Promise.resolve()), [])

  return {
    teamSpaces,
    spaceId: teamSpaces.find(space => space.id === wanted)?.id ?? null,
    chooseSpace: setChosen,
    whenSettled,
  }
}
