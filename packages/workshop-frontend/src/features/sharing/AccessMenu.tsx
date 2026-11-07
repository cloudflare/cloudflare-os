import type { Ref } from 'react'
import { Button, DropdownMenu, type PortalContainer } from '@cloudflare/kumo'
import { CaretDownIcon } from '@phosphor-icons/react'

type Props = {
  label: 'Member' | 'Can view'
  personName: string
  onRemove: () => void
  disabled: boolean
  container: PortalContainer
  triggerRef: Ref<HTMLButtonElement>
}

export const AccessMenu = ({ label, personName, onRemove, disabled, container, triggerRef }: Props) => (
  <DropdownMenu>
    <DropdownMenu.Trigger disabled={disabled} render={
      <Button ref={triggerRef} variant="ghost" size="sm" className="group" aria-label={`Access for ${personName}: ${label}`}>
        {label}<CaretDownIcon size={10} weight="bold" className="group-data-[popup-open]:rotate-180" />
      </Button>
    } />
    <DropdownMenu.Content container={container} align="end" sideOffset={6} className="space-y-0.5">
      <DropdownMenu.Item variant="danger" onClick={onRemove} className="text-xs">Remove</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>
)
