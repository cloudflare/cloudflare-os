import { BellIcon, BellSlashIcon, DotsThreeIcon, EnvelopeOpenIcon, EnvelopeSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import type { ButtonProps } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

export type ChatMoreMenuProps = {
  /** The chat's title, for the menu's name. */
  title: string
  /**
   * Whether the viewer has read it, and the way to mark it read or unread: `onChange(true)` marks
   * it read. Left out where it is not theirs to mark.
   */
  read?: { unread: boolean; onChange: (read: boolean) => void }
  /**
   * The ways its notifications can be changed for the viewer, in order, and the way to change
   * them. Left out where they are not the viewer's to change.
   */
  notifications?: { choices: { enabled: boolean; label: string }[]; onChange: (enabled: boolean) => void }
  /** Asks whether to delete the chat. Left out for whoever may not. */
  onDelete?: () => void
  triggerVariant?: ButtonProps['variant']
  /** Styles the button the menu opens from. */
  triggerClassName?: string
}

/**
 * What else can be done with a chat, for whoever may: mark it read or unread, whichever it is not,
 * turn its notifications on or mute them, and delete it, which asks first. Drawn only where there
 * is any of it.
 */
export const ChatMoreMenu = ({ title, read, notifications, onDelete, triggerVariant = 'ghost', triggerClassName }: ChatMoreMenuProps) => {
  const choices = notifications?.choices ?? []
  if (!read && choices.length === 0 && !onDelete) return null
  return (
    <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant={triggerVariant} triggerClassName={triggerClassName} align="end">
      {read && (read.unread
        ? <DropdownMenu.Item icon={EnvelopeOpenIcon} onSelect={() => read.onChange(true)}>Mark as read</DropdownMenu.Item>
        : <DropdownMenu.Item icon={EnvelopeSimpleIcon} onSelect={() => read.onChange(false)}>Mark as unread</DropdownMenu.Item>)}
      {choices.map(({ enabled, label }) => (
        <DropdownMenu.Item key={label} icon={enabled ? BellIcon : BellSlashIcon} onSelect={() => notifications?.onChange(enabled)}>{label}</DropdownMenu.Item>
      ))}
      {(read || choices.length > 0) && onDelete && <DropdownMenu.Separator />}
      {onDelete && <DropdownMenu.Item icon={TrashIcon} danger onSelect={onDelete}>Delete chat…</DropdownMenu.Item>}
    </DropdownMenu>
  )
}
