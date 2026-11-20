import { SWITCH_THUMB, SWITCH_TRACK } from '@gadgets/ui'

/**
 * What a switch shows, with nothing to press: for where the row it is in is the control, and
 * says the state in words to whatever reads it (`aria-hidden`, so say it beside).
 */
export const SwitchIndicator = ({ checked }: { checked: boolean }) => (
  <span aria-hidden="true" data-checked={checked ? '' : undefined} className={SWITCH_TRACK}>
    <span data-checked={checked ? '' : undefined} className={SWITCH_THUMB} />
  </span>
)
