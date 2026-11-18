import { AppWindowIcon, ArrowSquareOutIcon, DotsThreeIcon, GearSixIcon, LinkIcon, PencilSimpleIcon, StackPlusIcon, TrashIcon, UserPlusIcon } from '@phosphor-icons/react'
import type { ButtonProps } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'

/** What can be done to an output from its more menu, besides opening it: each left out for whoever may not. */
export type LibraryMoreActions = {
  /** Gives it another title, typed where its title is. */
  onRename?: (title: string) => void
  /** Invites people to use it. */
  onInvite?: () => void
  /** Goes to its settings. */
  onOpenSettings?: () => void
  /** Creates a template from it, or releases its changes as a template's next version. */
  onCreateTemplate?: () => void
  /** Asks whether to delete it. */
  onDelete?: () => void
}

export type LibraryMoreMenuProps = Omit<LibraryMoreActions, 'onRename'> & {
  /** The output's title, for the menu's name. */
  title: string
  /** Its page, which it is opened in another tab at and its link is copied from. */
  href?: string
  onOpen: () => void
  /** Has its title typed where it is, which `LibraryMoreActions.onRename` then keeps. */
  onRename?: () => void
  /** The trigger Button's variant: ghost over a list, as its star is. */
  triggerVariant?: ButtonProps['variant']
  /** Styles the button the menu opens from. */
  triggerClassName?: string
}

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/**
 * What else can be done with an output on the Library page: open it, here or from its address in
 * another tab, and copy its link; then, for whoever builds in its workspace, rename it, invite people to it, go to its settings and create a template from it; and after a line, delete it, which asks first.
 */
export const LibraryMoreMenu = ({ title, href, onOpen, onRename, onInvite, onOpenSettings, onCreateTemplate, onDelete, triggerVariant = 'ghost', triggerClassName }: LibraryMoreMenuProps) => (
  <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant={triggerVariant} triggerClassName={triggerClassName} align="end">
    <DropdownMenu.Item icon={AppWindowIcon} onSelect={onOpen}>Open</DropdownMenu.Item>
    {href && (
      <>
        <DropdownMenu.Item icon={ArrowSquareOutIcon} onSelect={() => window.open(href, '_blank', 'noopener')}>Open in new tab</DropdownMenu.Item>
        <DropdownMenu.Item icon={LinkIcon} onSelect={() => copyLink(href)}>Copy link</DropdownMenu.Item>
      </>
    )}
    {(onRename || onInvite || onOpenSettings || onCreateTemplate) && <DropdownMenu.Separator />}
    {onRename && <DropdownMenu.Item icon={PencilSimpleIcon} onSelect={onRename}>Rename</DropdownMenu.Item>}
    {onInvite && <DropdownMenu.Item icon={UserPlusIcon} onSelect={onInvite}>Invite user…</DropdownMenu.Item>}
    {onOpenSettings && <DropdownMenu.Item icon={GearSixIcon} onSelect={onOpenSettings}>App settings</DropdownMenu.Item>}
    {onCreateTemplate && <DropdownMenu.Item icon={StackPlusIcon} onSelect={onCreateTemplate}>Create template…</DropdownMenu.Item>}
    {onDelete && <DropdownMenu.Separator />}
    {onDelete && <DropdownMenu.Item icon={TrashIcon} danger onSelect={onDelete}>Delete…</DropdownMenu.Item>}
  </DropdownMenu>
)
