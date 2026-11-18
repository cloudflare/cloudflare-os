import { BellIcon, BellSlashIcon, DotsThreeIcon, TrashIcon } from '@phosphor-icons/react'
import type { ButtonProps } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

export type ChatMoreMenuProps = {
  /** The chat's title, for the menu's name. */
  title: string
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
 * What else can be done with a chat, for whoever may: turn its notifications on or mute them, and
 * delete it, which asks first. Drawn only where there is any of it.
 */
export const ChatMoreMenu = ({ title, notifications, onDelete, triggerVariant = 'ghost', triggerClassName }: ChatMoreMenuProps) => {
  const choices = notifications?.choices ?? []
  if (choices.length === 0 && !onDelete) return null
  return (
    <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant={triggerVariant} triggerClassName={triggerClassName} align="end">
      {choices.map(({ enabled, label }) => (
        <DropdownMenu.Item key={label} icon={enabled ? BellIcon : BellSlashIcon} onSelect={() => notifications?.onChange(enabled)}>{label}</DropdownMenu.Item>
      ))}
      {choices.length > 0 && onDelete && <DropdownMenu.Separator />}
      {onDelete && <DropdownMenu.Item icon={TrashIcon} danger onSelect={onDelete}>Delete chat…</DropdownMenu.Item>}
    </DropdownMenu>
  )
}
