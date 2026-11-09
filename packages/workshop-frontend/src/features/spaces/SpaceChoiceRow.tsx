import { useId, useRef, useState } from 'react'
import { Radio } from '@cloudflare/kumo'
import { CaretRight } from '@phosphor-icons/react'
import type { SubspaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { BusyButton } from './BusyButton'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'
import type { SpaceReads } from './useSpaceReads'

/** What `SpaceChoices` holds for every one of its rows, at whatever depth. */
export type SpaceChoiceTree = {
  /** The space the workspace is in: null for the personal one, undefined where there is none. */
  current: string | null | undefined
  /** The value of the radio that is chosen. */
  chosen: string
  /** Nothing can be chosen or expanded. */
  disabled: boolean
  /** The ids of the spaces that are expanded. */
  expanded: readonly string[]
  /** What was read of each expanded space (`useSubspaces`). */
  subspaces: SpaceReads<{ subspaces: SubspaceInfo[] }>
  /** Expands the space with this id, or collapses it. */
  onToggle: (spaceId: string) => void
  /** Reads the sub-spaces of the space with this id again, resolving once the read has settled. */
  onReload: (spaceId: string) => Promise<void>
  /** Chooses the radio with this value, as a press on it does. */
  onChoose: (value: string) => void
  /** The user settled on a choice (see `SpaceChoices`). */
  onChoicePress: (() => void) | undefined
}

const NOTE_CLASS_NAME = 'text-[12px] leading-4 text-kumo-subtle'
const ALERT_CLASS_NAME = 'text-[12px] leading-4 text-kumo-danger'

/**
 * One space of `SpaceChoices`: its radio, a button beside it that expands it, and, while it is
 * expanded, the sub-spaces directly inside it as rows of this kind, or what became of reading
 * them. A space offered in two places is two rows, expanded and chosen together, since both go
 * by the space's id.
 */
export const SpaceChoiceRow = ({ value, spaceId, name, isCurrent, tree }: {
  /** The value of the row's radio in the group. */
  value: string
  /**
   * The id the space's sub-spaces are read by. Undefined while it is not known, as the personal
   * space's is until the user's list of spaces has loaded: the row cannot be expanded then.
   */
  spaceId: string | undefined
  /** What the space is called. */
  name: string
  /** The workspace is in this space. */
  isCurrent: boolean
  tree: SpaceChoiceTree
}) => {
  const groupId = useId()
  const expandRef = useRef<HTMLButtonElement>(null)
  const [reloading, setReloading] = useState(false)
  // Gives the expand button the focus of a control that has left the row. A dialog or popup the
  // row is shown in takes the focus the browser drops, at once and once more on the next frame,
  // so focus on that container is focus nothing in it has.
  const focusExpandIfLost = () => {
    const expand = expandRef.current
    if (expand && document.activeElement === expand.closest('[role="dialog"]')) expand.focus()
    else takeLostFocus(expand)
  }
  // `Try again` goes once the sub-spaces have been read, or the space has refused, and the
  // expand button takes the focus it had, again after the frame in which a dialog takes it. A
  // read that failed again leaves it where it is.
  const reloadSettled = useFocusAfterAction(() => {
    focusExpandIfLost()
    requestAnimationFrame(focusExpandIfLost)
  })
  const open = spaceId !== undefined && tree.expanded.includes(spaceId)
  const read = open ? tree.subspaces[spaceId] : undefined

  const reload = async (id: string) => {
    setReloading(true)
    try {
      await tree.onReload(id)
    } finally {
      setReloading(false)
      reloadSettled()
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-1">
        {spaceId !== undefined && (
          // Above the radio: a radio takes the presses that land beside it, and a press here
          // expands the space and chooses nothing. Outside the radio's label for the same reason.
          <WorkshopIconButton
            ref={expandRef}
            aria-label={`Sub-spaces of ${name}`}
            aria-expanded={open}
            aria-controls={open ? groupId : undefined}
            className="relative z-10 !h-6 !w-6"
            disabled={tree.disabled}
            onClick={() => tree.onToggle(spaceId)}
          >
            <CaretRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
          </WorkshopIconButton>
        )}
        {/* A press on the radio or its label, and the Space key on the radio, arrive here as a
            click; the arrow keys, which choose as they move, do not. A radio does nothing on
            Enter, so where a choice settles Enter settles on the radio that has the focus. That
            is the chosen one where the arrow keys brought the focus. It is not where Tab did
            while the chosen space is not shown, being inside a space that is not expanded: it
            is chosen first then, as the Space key would choose it. */}
        <span
          // A disabled radio's label still takes a press, which settles on nothing.
          onClick={() => { if (!tree.disabled) tree.onChoicePress?.() }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || !tree.onChoicePress) return
            if (tree.chosen !== value) tree.onChoose(value)
            tree.onChoicePress()
          }}
        >
          <Radio.Item value={value} label={isCurrent ? `${name} (current)` : name} />
        </span>
      </div>
      {open && (
        <div id={groupId} role="group" aria-label={`Sub-spaces of ${name}`} className="flex flex-col gap-2 pl-7">
          {read === undefined || read.status === 'loading' ? (
            <p role="status" className={NOTE_CLASS_NAME}>Loading…</p>
          ) : read.status === 'ready' ? (
            read.subspaces.length === 0
              ? <p className={NOTE_CLASS_NAME}>No sub-spaces.</p>
              : read.subspaces.map(subspace => (
                  <SpaceChoiceRow
                    key={subspace.id}
                    value={subspace.id}
                    spaceId={subspace.id}
                    name={subspace.name}
                    isCurrent={tree.current === subspace.id}
                    tree={tree}
                  />
                ))
          ) : read.status === 'refused' ? (
            <p role="alert" className={ALERT_CLASS_NAME}>
              You are no longer a member of this space.
            </p>
          ) : (
            <div className="flex items-center gap-3">
              <p role="alert" className={ALERT_CLASS_NAME}>
                Couldn’t load the sub-spaces.
              </p>
              <BusyButton
                className={SPACE_ACTION_CLASS_NAME}
                aria-label={`Try again to load the sub-spaces of ${name}`}
                busy={reloading}
                onClick={() => void reload(spaceId)}
              >
                Try again
              </BusyButton>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
