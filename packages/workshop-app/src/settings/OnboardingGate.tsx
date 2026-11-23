import { useEffect, useState, type ReactNode } from 'react'
import { AlertCircleIcon } from '@/components/icons'
import { PaneNotice } from '@/blocks/PaneNotice'
import { useApi } from '@/rpc/ApiContext'
import { Onboarding } from './Onboarding'
import { messageOf } from './useAttempt'

// A failure is kept with the connection it came over, so that a new one asks again.
type Known = { userId: string } & ({ status: 'read'; finished: boolean } | { status: 'failed'; message: string; attempt: number; api: unknown })

/**
 * Renders `children` once the user is set up (`isOnboardingCompleted()`), and setting up
 * (`Onboarding`) in their place until then. Asked once for each user signed in, not again on a new
 * connection once answered. Where it cannot be asked, it says so and asks again on Try again or a
 * new connection, rather than letting a user who was never set up in as if they had been.
 */
export const OnboardingGate = ({ children }: { children: ReactNode }) => {
  const { api, user, reconnecting } = useApi()
  const [attempt, setAttempt] = useState(0)
  const [known, setKnown] = useState<Known>()
  const answered = known?.userId === user.id && (known.status === 'read' || (known.attempt === attempt && known.api === api))

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (answered || reconnecting) return
    let cancelled = false
    const userId = user.id
    api.isOnboardingCompleted().then(
      (finished) => {
        if (!cancelled) setKnown({ userId, status: 'read', finished })
      },
      (error: unknown) => {
        if (!cancelled) setKnown({ userId, status: 'failed', message: messageOf(error), attempt, api })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, user.id, reconnecting, answered, attempt])

  if (!answered || !known) {
    return <p role="status" className="appears-late grid h-full place-items-center bg-kumo-canvas p-6 text-base text-kumo-subtle">Loading…</p>
  }
  if (known.status === 'failed') {
    return (
      <div className="flex h-dvh bg-kumo-canvas">
        <PaneNotice icon={AlertCircleIcon} title="Couldn’t check whether you’re set up" description={known.message} action={{ label: 'Try again', onClick: () => setAttempt((at) => at + 1) }} />
      </div>
    )
  }
  if (!known.finished) return <Onboarding onDone={() => setKnown({ userId: user.id, status: 'read', finished: true })} />
  return children
}
