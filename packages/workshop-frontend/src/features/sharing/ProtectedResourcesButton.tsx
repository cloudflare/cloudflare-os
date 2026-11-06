import type { Ref } from 'react'
import { Button } from '@cloudflare/kumo'
import { CaretRightIcon, LockSimpleIcon } from '@phosphor-icons/react'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'

type Props = {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
  onOpen: () => void
  buttonRef: Ref<HTMLButtonElement>
}

/** Opens the protected resources view; hidden while loading or when there is nothing to verify. */
export const ProtectedResourcesButton = ({ requirements, failed, onOpen, buttonRef }: Props) => {
  if (!failed && (requirements === null || requirements.length === 0)) return null
  return (
    <Button ref={buttonRef} size="sm" variant="ghost"
      className="w-auto min-w-0 shrink gap-1.5 self-center sm:self-auto px-2.5 h-auto py-1.5 rounded-full! bg-kumo-banner-info hover:bg-kumo-info-tint text-kumo-info!" aria-label="Protected resources" onClick={onOpen}>
      <LockSimpleIcon size={12} weight="bold" /><span className="truncate">Protected resources</span>
      {requirements && !failed && <span>({requirements.length})</span>}<CaretRightIcon size={10} weight="bold" />
    </Button>
  )
}
