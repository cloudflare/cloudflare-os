import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { useSpaces } from './useSpaces'

/**
 * The space a new workspace is created in, for a screen that lets the user pick it.
 *
 * `spaceKey` is a team space's key, or null for the user's personal space. It starts as `preset`
 * (the `space` search parameter of a link that asks for a space) and follows the user's choice
 * once they make one; either counts only while it names one of `teamSpaces`, the team spaces the
 * user is a member of, so it is null until that list has loaded and while the `spaces` flag is
 * off.
 */
export const useNewWorkspaceSpace = (preset: string | undefined): {
  teamSpaces: SpaceInfo[]
  spaceKey: string | null
  /** The user has chosen a space themself, so `preset` no longer counts. */
  chosen: boolean
  chooseSpace: (spaceKey: string | null) => void
  /**
   * Resolves once `spaceKey` no longer waits on anything: at once, unless a preset is still to be
   * told from the `spaces` flag and the list of spaces whether it counts. What creates a workspace
   * for a link that asks for a space awaits it, so the link is honoured however early that is.
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
    spaceKey: teamSpaces.find(space => space.key === wanted)?.key ?? null,
    chosen: chosen !== undefined,
    chooseSpace: setChosen,
    whenSettled,
  }
}
