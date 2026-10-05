import { Select } from '@cloudflare/kumo'
import type { SpaceMemberRole } from '@gadgets/workshop-shared/api'
import { SPACE_ROLE_LABELS } from './spaceRoles'

/** Picks one of the roles a member can be given. */
export const SpaceRoleSelect = ({ label, value, roles, disabled, container, onValueChange }: {
  /** The accessible name: whose role this is, or what the role is for. */
  label: string
  value: SpaceMemberRole
  roles: readonly SpaceMemberRole[]
  disabled: boolean
  /** Where the options are rendered, so they sit above the dialog the select is in. */
  container: HTMLElement | null
  onValueChange: (role: SpaceMemberRole) => void
}) => (
  <Select<SpaceMemberRole>
    aria-label={label}
    className="w-[104px] shrink-0 text-sm"
    value={value}
    onValueChange={(role) => { if (role) onValueChange(role) }}
    renderValue={(role) => SPACE_ROLE_LABELS[role]}
    disabled={disabled}
    container={container}
  >
    {roles.map(role => (
      <Select.Option key={role} value={role}>{SPACE_ROLE_LABELS[role]}</Select.Option>
    ))}
  </Select>
)
