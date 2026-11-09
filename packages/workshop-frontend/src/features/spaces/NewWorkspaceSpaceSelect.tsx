import { useRef, useState } from 'react'
import { Popover } from '@cloudflare/kumo'
import { CaretDown } from '@phosphor-icons/react'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { WorkshopButton } from '../../components/WorkshopControls'
import { SpaceChoices, type SpaceChoice } from './SpaceChoices'

/**
 * Picks the space a new workspace is created in: a button that names the space chosen and
 * opens the user's spaces, each of which expands to its sub-spaces (`SpaceChoices`). It closes
 * when a space is pressed, or Enter is pressed on one, and stays open while the arrow keys move
 * through the spaces and while one is expanded.
 */
export const NewWorkspaceSpaceSelect = ({ spaces, value, disabled, onValueChange }: {
  /** The user's spaces (`useSpaces`), the personal one included. */
  spaces: SpaceInfo[]
  /** The chosen space, or null for the personal space. */
  value: SpaceChoice | null
  /** The workspace is being created, so its space is not to choose. */
  disabled: boolean
  onValueChange: (choice: SpaceChoice | null) => void
}) => {
  const [open, setOpen] = useState(false)
  const choicesRef = useRef<HTMLDivElement>(null)
  const name = value?.name ?? 'Personal'
  return (
    <div className="flex items-center gap-2 text-[12px] leading-4 text-kumo-subtle">
      <span aria-hidden="true">Space</span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          render={(
            <WorkshopButton
              aria-label={`Space: ${name}`}
              className="!h-7 max-w-[220px] gap-1.5 !px-2.5 !text-[12px]"
              disabled={disabled}
            >
              <span className="truncate">{name}</span>
              <CaretDown size={12} className="shrink-0" />
            </WorkshopButton>
          )}
        />
        <Popover.Portal>
          <Popover.Positioner align="end">
            <Popover.Popup
              className="w-64 !px-3"
              // The chosen space, as a list of options opens on the one selected: left to itself
              // the popup gives the focus to the first control in it, an expand button, from
              // which the arrow keys choose nothing, since `SpaceChoices` lets the group of
              // radios have them from a radio alone. When the chosen space is not shown, being
              // inside a space that is not expanded, the popup's own choice stands.
              initialFocus={() => choicesRef.current
                ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? null}
            >
              <Popover.Title className="sr-only">Space</Popover.Title>
              {/* A box that scrolls clips what is drawn outside it, a focus ring included: the
                  padding leaves a ring room, and the margin keeps the spaces where they were. */}
              <div ref={choicesRef} className="-m-1 max-h-[min(320px,50vh)] overflow-y-auto p-1">
                <SpaceChoices
                  spaces={spaces}
                  value={value?.id ?? null}
                  disabled={disabled}
                  onValueChange={onValueChange}
                  onChoicePress={() => setOpen(false)}
                />
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </div>
  )
}
