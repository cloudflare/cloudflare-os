import type { Ref } from 'react'
import { DropdownMenu, type PortalContainer } from '@cloudflare/kumo'
import { ChevronDownIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from '../../components/menuStyles'

/** The class of a person's access trigger: their access, as a quiet button with a caret. */
export const ACCESS_TRIGGER =
  'group inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 text-[13px] font-medium leading-4 text-kumo-default transition-colors hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-kumo-tint'

type Props = {
  label: 'Member' | 'Can use'
  personName: string
  onRemove: () => void
  disabled: boolean
  container: PortalContainer
  triggerRef: Ref<HTMLButtonElement>
}

export const AccessMenu = ({ label, personName, onRemove, disabled, container, triggerRef }: Props) => (
  <DropdownMenu>
    <DropdownMenu.Trigger disabled={disabled} render={
      <button ref={triggerRef} type="button" className={ACCESS_TRIGGER} aria-label={`Access for ${personName}: ${label}`}>
        {label}<ChevronDownIcon size={12} className="text-kumo-subtle transition-transform group-data-[popup-open]:rotate-180" />
      </button>
    } />
    <DropdownMenu.Content container={container} align="end" sideOffset={6} className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
      <DropdownMenu.Item variant="danger" onClick={onRemove} className={MENU_ITEM_DANGER}>Remove access</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>
)
