import type { Ref } from 'react'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { ChevronRightIcon, LockFilledIcon } from '../../components/icons/designIcons'
import { shareFooterPillClass } from './ShareDialogFrame'

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
    <button ref={buttonRef} type="button" className={shareFooterPillClass} aria-label="Protected resources" onClick={onOpen}>
      <LockFilledIcon size={12} className="shrink-0" />
      <span className="truncate">Protected resources</span>
      {requirements && !failed && <span className="text-kumo-subtle">{requirements.length}</span>}
      <ChevronRightIcon size={12} className="shrink-0 text-kumo-subtle" />
    </button>
  )
}
