import type { Ref } from 'react'
import { EyeIcon } from '@phosphor-icons/react'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { ChevronRightIcon } from '../../components/icons/designIcons'
import { shareFooterPillClass } from '../sharing/ShareDialogFrame'

type Props = {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
  /** Whether anyone has been given the gadget yet, which sets the tense. */
  hasRecipients: boolean
  onOpen: () => void
  buttonRef: Ref<HTMLButtonElement>
}

/**
 * Opens "What people see" where the deployment serves shared views; it stands in for
 * `ProtectedResourcesButton` and, like it, is hidden while loading or when nothing needs access.
 */
export const SharedViewButton = ({ requirements, failed, hasRecipients, onOpen, buttonRef }: Props) => {
  if (!failed && (requirements === null || requirements.length === 0)) return null
  const label = hasRecipients ? 'People without access see a snapshot' : 'People without access will see a snapshot'
  return (
    <button ref={buttonRef} type="button" className={shareFooterPillClass} onClick={onOpen}>
      <EyeIcon size={13} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
      <ChevronRightIcon size={12} className="shrink-0 text-kumo-subtle" />
    </button>
  )
}
