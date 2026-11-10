import { Select } from '@cloudflare/kumo'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'

// The option standing for the user's own personal space, which a new workspace is created in when
// no id is given. No space id equals it: an id is made by the server, and is never a word.
const PERSONAL = 'personal'

/**
 * Picks the space a new workspace is created in: the user's personal space, or one of the team
 * spaces they are a member of.
 */
export const NewWorkspaceSpaceSelect = ({ teamSpaces, value, disabled, onValueChange }: {
  /** The team spaces offered besides the personal space. */
  teamSpaces: SpaceInfo[]
  /**
   * The chosen team space's id, or null for the personal space. A value that is none of
   * `teamSpaces` reads as the personal space, which is where `useNewWorkspaceSpace` creates the
   * workspace then.
   */
  value: string | null
  /** The workspace is being created, so its space is no longer to choose. */
  disabled: boolean
  onValueChange: (spaceId: string | null) => void
}) => {
  const chosen = teamSpaces.find(space => space.id === value)
  return (
    <div className="flex items-center gap-2 text-[12px] leading-4 text-kumo-subtle">
      <span aria-hidden="true">Space</span>
      <Select<string>
        aria-label="Space"
        size="sm"
        className="max-w-[220px]"
        value={chosen?.id ?? PERSONAL}
        disabled={disabled}
        onValueChange={(option) => {
          if (option !== null) onValueChange(option === PERSONAL ? null : option)
        }}
        renderValue={(option) => teamSpaces.find(space => space.id === option)?.name ?? 'Personal'}
      >
        <Select.Option value={PERSONAL}>Personal</Select.Option>
        {teamSpaces.map(space => (
          <Select.Option key={space.id} value={space.id}>{space.name}</Select.Option>
        ))}
      </Select>
    </div>
  )
}
