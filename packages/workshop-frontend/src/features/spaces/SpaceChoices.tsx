import { useState } from 'react'
import { Radio } from '@cloudflare/kumo'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { SpaceChoiceRow } from './SpaceChoiceRow'
import { useSubspaces } from './useSubspaces'

/** A space a workspace can be placed in, as `SpaceChoices` reports the one chosen. */
export type SpaceChoice = { id: string; name: string }

// The radio value standing for the user's own personal space, which is reported as null. No
// space id equals it: an id is made by the server, and is never a word.
const PERSONAL = 'personal'

/**
 * The spaces a workspace can be placed in, as one group of radios: the user's personal space,
 * then the spaces of their own list. Each expands, from a button beside it, to the sub-spaces
 * directly inside it, which are read when it is expanded and expand in turn, so a sub-space at
 * any depth can be chosen. A space the user was added to is at the top level whatever it is
 * inside, since their list does not say; one they can also reach from above is then offered in
 * both places.
 */
export const SpaceChoices = ({ spaces, value, current, disabled, onValueChange, onChoicePress }: {
  /**
   * The user's spaces (`useSpaces`): the top level. Empty while the list has not loaded, when
   * the personal space alone is offered and cannot be expanded.
   */
  spaces: SpaceInfo[]
  /** The chosen space's id, or null for the user's personal space. */
  value: string | null
  /**
   * The space the workspace is in now, null for the personal one, which is marked as such
   * wherever it is offered. Undefined where no workspace exists yet.
   */
  current?: string | null
  /** Nothing can be chosen or expanded. */
  disabled: boolean
  /** The user chose a space: null for their personal space. */
  onValueChange: (choice: SpaceChoice | null) => void
  /**
   * The user settled on a choice: pressed one with a pointer, the Space key or Enter, the one
   * chosen already included; `onValueChange` reports it first when it was not. As opposed to
   * one the arrow keys passed over, which `onValueChange` alone reports. For a caller that
   * closes once the user has settled on a space. Without it Enter on a space does nothing.
   */
  onChoicePress?: () => void
}) => {
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const { subspaces, reload } = useSubspaces(expanded)
  const personal = spaces.find(space => space.kind === 'personal')
  const teamSpaces = spaces.filter(space => space.kind === 'team')

  // Every radio shown is a space of the list or a sub-space that was read, so one of the two
  // names the space a radio's value is the id of.
  const choiceOf = (id: string): SpaceChoice | undefined => {
    const found = teamSpaces.find(space => space.id === id) ?? Object.values(subspaces)
      .flatMap(read => (read.status === 'ready' ? read.subspaces : []))
      .find(subspace => subspace.id === id)
    return found && { id: found.id, name: found.name }
  }

  const choose = (chosen: string) => {
    if (chosen === PERSONAL) return onValueChange(null)
    const choice = choiceOf(chosen)
    if (choice) onValueChange(choice)
  }

  const tree = {
    current,
    chosen: value ?? PERSONAL,
    disabled,
    expanded,
    subspaces,
    onToggle: (id: string) => setExpanded(ids => (
      ids.includes(id) ? ids.filter(each => each !== id) : [...ids, id]
    )),
    onReload: reload,
    onChoose: choose,
    onChoicePress,
  }

  return (
    // A group of radios notes an arrow key pressed on anything inside it, on the key's way down
    // to the control, and chooses the next radio in it to take the focus. From a radio that is
    // the one the key moves the focus to. From an expand button or `Try again` it is the radio
    // after the one holding the tab stop, wherever the user was. And where the key moves nothing
    // (nothing can be chosen, Control, Alt or Meta is held, or the radio is the only one shown)
    // it is whichever radio the Tab key lands on later. A control inside the group hears the key
    // too late to keep it, so the key is stopped here, outside the group, unless it comes from a
    // radio the group will move the focus from. The element is here for the key alone, and lays
    // nothing out.
    <div
      className="contents"
      onKeyDownCapture={(event) => {
        if (!event.key.startsWith('Arrow')) return
        const onRadio = event.target instanceof Element && event.target.matches('[role="radio"]')
        const moves = onRadio && !disabled && !(event.altKey || event.ctrlKey || event.metaKey)
          && event.currentTarget.querySelectorAll('[role="radio"]').length > 1
        if (!moves) event.stopPropagation()
      }}
    >
      <Radio.Group
        // A name of one word too long for its row, which is narrower the deeper the space, breaks
        // inside the word: the group would otherwise be as wide as the word, and its box scroll
        // sideways.
        className="[overflow-wrap:anywhere]"
        value={tree.chosen}
        disabled={disabled}
        onValueChange={choose}
      >
        <Radio.Legend className="sr-only">Space</Radio.Legend>
        <SpaceChoiceRow
          value={PERSONAL}
          spaceId={personal?.id}
          name="Personal"
          isCurrent={current === null}
          tree={tree}
        />
        {teamSpaces.map(space => (
          <SpaceChoiceRow
            key={space.id}
            value={space.id}
            spaceId={space.id}
            name={space.name}
            isCurrent={current === space.id}
            tree={tree}
          />
        ))}
      </Radio.Group>
    </div>
  )
}
