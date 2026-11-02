import { Select } from '@cloudflare/kumo'
import { PERSONAL_SPACE_PREFIX, type SpaceInfo } from '@gadgets/workshop-shared/api'

// The option standing for the user's own personal space, which a new workspace is created in when
// no key is given. No team key can equal it: a team key cannot start with the prefix.
const PERSONAL = PERSONAL_SPACE_PREFIX

/**
 * Picks the space a new workspace is created in: the user's personal space, or one of the team
 * spaces they are a member of.
 */
export const NewWorkspaceSpaceSelect = ({ teamSpaces, value, disabled, onValueChange }: {
  /** The team spaces offered besides the personal space. */
  teamSpaces: SpaceInfo[]
  /** The chosen team space's key, or null for the personal space. */
  value: string | null
  /** The workspace is being created, so its space is no longer to choose. */
  disabled: boolean
  onValueChange: (spaceKey: string | null) => void
}) => {
  const nameOf = (option: string) =>
    option === PERSONAL ? 'Personal' : teamSpaces.find(space => space.key === option)?.name ?? option
  return (
    <div className="flex items-center gap-2 text-[12px] leading-4 text-kumo-subtle">
      <span aria-hidden="true">Space</span>
      <Select<string>
        aria-label="Space"
        size="sm"
        className="max-w-[220px]"
        value={value ?? PERSONAL}
        disabled={disabled}
        onValueChange={(option) => {
          if (option !== null) onValueChange(option === PERSONAL ? null : option)
        }}
        renderValue={nameOf}
      >
        <Select.Option value={PERSONAL}>Personal</Select.Option>
        {teamSpaces.map(space => (
          <Select.Option key={space.key} value={space.key}>{space.name}</Select.Option>
        ))}
      </Select>
    </div>
  )
}
