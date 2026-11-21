import { Badge } from '@cloudflare/kumo'
import { CopyIcon, DotsThreeIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { ConfirmMenu, DropdownMenu, LIST_ACTION, Tag } from '@gadgets/ui'

export type ModelListItemProps = {
  /** What the model is called. */
  name: string
  /** What its provider knows it as, where that is not its name. */
  id: string
  /** The deployment provides it, rather than the user having added it. */
  builtIn?: boolean
  /** What it is used for by default: answering, the quick tasks, or both. */
  roles?: ('default' | 'quick')[]
  /** Opens it to be changed, where it is the user's. */
  onEdit?: () => void
  /** Opens another like it to be added, with the same key, where it is the user's. */
  onDuplicate?: () => void
  /** Removes it from the user's models, where it is theirs to remove. Asked for twice. */
  onRemove?: () => void
  /** Removing it is under way. */
  busy?: boolean
}

const ROLE = { default: 'Default', quick: 'Quick' }

/**
 * One of the user's AI models, on one line: its name over what its provider knows it as, what it
 * is used for, whether the deployment provides it, and for one the user added, a menu to change it
 * or add another like it, and the way to remove it.
 */
export const ModelListItem = ({ name, id, builtIn = false, roles = [], onEdit, onDuplicate, onRemove, busy = false }: ModelListItemProps) => (
  <li className="flex items-center gap-3 border-t border-kumo-line py-3 first:border-t-0">
    <span className="flex min-w-0 flex-1 flex-col leading-snug">
      <span className="truncate font-medium text-kumo-default">{name}</span>
      {id !== name && <span className="truncate text-sm text-kumo-subtle">{id}</span>}
    </span>
    {roles.map((role) => <Badge key={role} variant="info">{ROLE[role]}</Badge>)}
    {builtIn && <Tag>Built-in</Tag>}
    {(onEdit || onDuplicate) && (
      <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${name}`} triggerVariant="ghost" triggerClassName={LIST_ACTION} align="end">
        {onEdit && <DropdownMenu.Item icon={PencilSimpleIcon} onSelect={onEdit} disabled={busy}>Edit…</DropdownMenu.Item>}
        {onDuplicate && <DropdownMenu.Item icon={CopyIcon} onSelect={onDuplicate} disabled={busy}>Duplicate…</DropdownMenu.Item>}
      </DropdownMenu>
    )}
    {onRemove && (
      <ConfirmMenu
        icon={TrashIcon}
        aria-label={`Remove ${name}`}
        triggerVariant="ghost"
        triggerClassName={LIST_ACTION}
        title={`Remove ${name}?`}
        description="It can no longer be chosen for chats. Messages it wrote stay where they are."
        confirmLabel="Remove"
        onConfirm={onRemove}
        disabled={busy}
      />
    )}
  </li>
)
