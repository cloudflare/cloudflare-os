import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { Onboarding } from './Onboarding'

/**
 * Renders `children` once the user is set up (`isOnboardingCompleted()`), and setting up
 * (`Onboarding`) in their place until then. Asked once for each user signed in, not again on a new
 * connection. Where it cannot be asked, the user is let in rather than kept out, as the old app
 * did: setting up is only a help.
 */
export const OnboardingGate = ({ children }: { children: ReactNode }) => {
  const { api, user, reconnecting } = useApi()
  const [known, setKnown] = useState<{ userId: string; completed: boolean }>()
  const answered = known?.userId === user.id

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (answered || reconnecting) return
    let cancelled = false
    const userId = user.id
    api.isOnboardingCompleted().then(
      (completed) => {
        if (!cancelled) setKnown({ userId, completed })
      },
      () => {
        if (!cancelled) setKnown({ userId, completed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, user.id, reconnecting, answered])

  if (!answered) {
    return <p role="status" className="appears-late grid h-full place-items-center bg-kumo-canvas p-6 text-base text-kumo-subtle">Loading…</p>
  }
  if (!known.completed) return <Onboarding onDone={() => setKnown({ userId: user.id, completed: true })} />
  return children
}
