import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import type { SpaceChoice } from './SpaceChoices'
import { couldBeSpaceId } from './spaceIds'
import { useSpaceInfos } from './useSpaceInfos'
import { useLastKnown, useSpaces } from './useSpaces'
import { useSubspaces } from './useSubspaces'

/**
 * The space a new workspace is created in, for a screen that lets the user pick it.
 *
 * `space` is the space, or null for the user's personal space. It is null while the `spaces`
 * flag is off and until the user's list of spaces has loaded. After that it is the user's own
 * choice once they have made one: `SpaceChoices` offers only what the server listed for them.
 * Until then it follows `preset` (the `space` search parameter of a link that asks for a
 * space): a team space of the user's list counts at once; any other string that could be a
 * space id is opened to learn whether the user may open it, and counts if it is a team space
 * they can, which is how a sub-space reached from above is named by a link; anything else is
 * the personal space.
 */
export const useNewWorkspaceSpace = (preset: string | undefined): {
  /** The user's spaces, the top level of what the screen offers: empty until loaded, and while the flag is off. */
  spaces: SpaceInfo[]
  /**
   * Whether there is a space to choose besides the personal one: a team space in the user's
   * list, a sub-space of their personal space, or `space` itself when it is not the personal
   * one. The personal space's sub-spaces are read for this, once in a session, only for a user
   * whose list has no team space. Until one of these says there is a choice there is none;
   * once one has, there is one until a read of those sub-spaces finds none, so a read that is
   * under way or has failed takes no choice away.
   */
  hasChoice: boolean
  space: SpaceChoice | null
  chooseSpace: (choice: SpaceChoice | null) => void
  /**
   * Resolves once `space` no longer waits on anything: at once, unless a preset is still to be
   * told from the `spaces` flag, the list of spaces and, for one the list does not have, the
   * space itself whether it counts. What sends a workspace's first message awaits it, so a link
   * that asks for a space is honoured however early that is.
   */
  whenSettled: () => Promise<void>
} => {
  const flag = useUiFeatureFlag('spaces')
  const { spaces, loading } = useSpaces()
  const personal = spaces.find(space => space.kind === 'personal')
  const teamSpaces = spaces.filter(space => space.kind === 'team')
  // Undefined until the user chooses.
  const [chosen, setChosen] = useState<SpaceChoice | null | undefined>(undefined)

  const { subspaces } = useSubspaces(teamSpaces.length === 0 && personal ? [personal.id] : [])
  const inPersonal = personal && subspaces[personal.id]
  // Undefined while no read of them has answered.
  const personalHasSubspaces = inPersonal?.status === 'ready' ? inPersonal.subspaces.length > 0 : undefined

  const listed = teamSpaces.find(space => space.id === preset)
  // A preset the list does not settle: it may name a space the user reaches from a space above.
  const unlisted = chosen === undefined && preset !== undefined && spaces.length > 0 && !listed
    && preset !== personal?.id && couldBeSpaceId(preset)
    ? preset
    : undefined
  const { infos } = useSpaceInfos(unlisted === undefined ? [] : [unlisted])
  const answered = unlisted !== undefined && infos[unlisted] !== undefined && infos[unlisted].status !== 'loading'
  // A session that replaces another reads the space again: what it last answered stays until
  // then, so the workspace's space does not turn personal and back on a reconnect.
  const lastInfos = useLastKnown(infos, answered)
  const opened = unlisted === undefined ? undefined : lastInfos[unlisted]
  const opening = unlisted !== undefined && (opened === undefined || opened.status === 'loading')

  const fromPreset = (): SpaceChoice | null => {
    if (listed) return { id: listed.id, name: listed.name }
    return opened?.status === 'ready' && opened.info.kind === 'team'
      ? { id: opened.info.id, name: opened.info.name }
      : null
  }
  const space = spaces.length === 0 ? null : chosen === undefined ? fromPreset() : chosen
  // A space that is not the personal one is itself a choice, so the user is always shown, and
  // can change, the space the workspace is created in. A session that replaces another reads
  // the personal space's sub-spaces again, and that read may fail: the choice there was stays
  // until a read answers, so the picker is not taken from under the user.
  const offered = teamSpaces.length > 0 || space !== null || personalHasSubspaces === true
  const hadChoice = useLastKnown(offered, offered || personalHasSubspaces === false)
  const hasChoice = spaces.length > 0 && hadChoice

  const presetPending = chosen === undefined && preset !== undefined
    && (flag.loading || loading || opening)
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
    spaces,
    hasChoice,
    space,
    chooseSpace: setChosen,
    whenSettled,
  }
}
