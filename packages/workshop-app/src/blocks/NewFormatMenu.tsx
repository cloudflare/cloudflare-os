import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { FormatIcon } from '@/components/FormatIcon'

export type NewFormatMenuProps = {
  /** What a new one can be started as (`startableFormats`), in the deployment's order. */
  formats: BlueprintOutput[]
  /** Starts a chat that makes something new: as `format`, when one was chosen. */
  onNew: (format?: BlueprintOutput) => void
  /** Where it opens: up from a toolbar under the list, as on a narrow screen. */
  side?: 'top' | 'bottom'
  /** Drawn as the page's main action, as it is unless the page has another, such as New chat. */
  primary?: boolean
}

/**
 * New, at the end of a list of what was made: a menu of the formats something can be started as,
 * opening in its place. With none to choose between, or until they are known, it starts a chat at
 * once.
 */
export const NewFormatMenu = ({ formats, onNew, side = 'bottom', primary = true }: NewFormatMenuProps) =>
  formats.length > 0
    ? (
        <DropdownMenu label="New" caret triggerVariant={primary ? 'primary' : 'secondary'} side={side} align="end" inPlace>
          {formats.map((format) => (
            <DropdownMenu.Item key={format.id} label={format.noun} onSelect={() => onNew(format)}>
              <FormatIcon name={format.icon} className="shrink-0" />
              {format.noun}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu>
      )
    : <Button variant={primary ? 'primary' : 'secondary'} onClick={() => onNew()}>New</Button>
