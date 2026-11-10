import { useState } from 'react'
import { WorkshopButton } from '../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { BusyButton } from './BusyButton'

/**
 * How a member leaves a team space: a button, then a question in its place, so that a double
 * click on the button cannot also confirm.
 */
export const SpaceLeave = ({ disabled, onLeave }: {
  /** Another change to the space is in flight, so the leave cannot be started. */
  disabled: boolean
  /** Leaves the space. Resolves once the user has left; rejects with what the server refused. */
  onLeave: () => Promise<void>
}) => {
  // `declined` is `idle` reached by declining the question, which hands the focus back to the
  // button that asked it.
  const [step, setStep] = useState<'idle' | 'confirming' | 'declined'>('idle')
  const [leaving, setLeaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const handleLeave = async () => {
    setLeaving(true)
    setFailure(null)
    try {
      await onLeave()
    } catch (err) {
      logRpcFailure('Failed to leave a space:', err)
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t leave the space. Try again.')
    } finally {
      setLeaving(false)
    }
  }

  if (step !== 'confirming') {
    return (
      <WorkshopButton
        autoFocus={step === 'declined'}
        className="mr-auto"
        disabled={disabled}
        onClick={() => setStep('confirming')}
      >
        Leave space
      </WorkshopButton>
    )
  }
  return (
    <>
      {failure && (
        <p role="alert" className="w-full text-[12px] leading-4 text-kumo-danger">{failure}</p>
      )}
      <p className="mr-auto text-[13px] leading-[18px] text-kumo-default">Leave this space?</p>
      <WorkshopButton
        autoFocus
        disabled={disabled || leaving}
        onClick={() => {
          setStep('declined')
          setFailure(null)
        }}
      >
        Cancel
      </WorkshopButton>
      <BusyButton tone="danger" busy={leaving} disabled={disabled} onClick={() => void handleLeave()}>
        {leaving ? 'Leaving…' : 'Leave'}
      </BusyButton>
    </>
  )
}
