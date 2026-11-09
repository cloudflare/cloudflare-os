import type { ComponentProps } from 'react'
import { Loader } from '@cloudflare/kumo'
import { WorkshopButton } from '../../components/WorkshopControls'

/** The look of a control that is busy with the call its own press started (see `BusyButton`). */
export const BUSY_CONTROL_CLASS_NAME = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50'

/**
 * A button whose press starts a call. While that call is in flight the button is not disabled,
 * because a browser takes the focus from a control that becomes disabled and does not give it
 * back: it stays focusable, says that it is unavailable, dims, shows the spinner, and ignores a
 * press. The focus is then still on it when the call has failed and the user is to act again.
 */
export const BusyButton = ({ busy, icon, className = '', onClick, ...props }: ComponentProps<typeof WorkshopButton> & {
  /** The call this button's press started is in flight. */
  busy: boolean
}) => (
  <WorkshopButton
    {...props}
    icon={busy ? <Loader size={14} /> : icon}
    aria-disabled={busy || undefined}
    className={`${BUSY_CONTROL_CLASS_NAME} ${className}`}
    onClick={(event) => {
      // Prevented as well as ignored: a submit button's press would otherwise submit its form.
      if (busy) event.preventDefault()
      else onClick?.(event)
    }}
  />
)
