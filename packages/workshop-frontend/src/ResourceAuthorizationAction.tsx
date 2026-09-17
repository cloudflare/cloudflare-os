import { useEffect, useRef, useState } from 'react'
import type { ResourceConfiguratorAuthorization } from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton } from './components/WorkshopControls'

// A stable name so a second click renavigates the same tab: the account holds one pending OAuth
// flow, so a second tab would strand the first on a superseded nonce.
const AUTHORIZATION_WINDOW_NAME = 'gadgets-gatekeeper-authorization'

/** Trusted control that runs a gatekeeper's account authorization outside the configurator iframe. */
export const ResourceAuthorizationAction = ({
  authorization,
}: {
  authorization: ResourceConfiguratorAuthorization
}) => {
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  // The blank window awaiting this component's current request. Identity is the generation check:
  // a late answer belongs to a superseded request exactly when this no longer holds its popup.
  const inFlight = useRef<Window | null>(null)

  useEffect(() => () => {
    inFlight.current?.close()
    inFlight.current = null
  }, [])

  const requestAuthorization = async () => {
    const popup = window.open('about:blank', AUTHORIZATION_WINDOW_NAME)
    if (!popup) {
      setMessage('Allow popups and try again.')
      return
    }

    popup.opener = null
    inFlight.current = popup
    setPending(true)
    setMessage(null)

    try {
      const result = await authorization.request()
      if (inFlight.current !== popup) return

      if (!result.url) {
        popup.close()
        setMessage('Access is already available. Retry your selection below.')
        return
      }

      const url = new URL(result.url)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        throw new Error('Invalid authorization URL')
      }

      popup.location.replace(url.href)
      setMessage('Complete authorization in the new tab, then return and retry your selection below.')
    } catch {
      if (inFlight.current !== popup) return
      popup.close()
      setMessage('Could not start authorization. Please try again.')
    } finally {
      // Only the request that still owns the window settles the control; unmount clears it first.
      if (inFlight.current === popup) {
        inFlight.current = null
        setPending(false)
      }
    }
  }

  return (
    <section className="mb-3 rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-3 text-[12px] leading-4">
      <div className="font-medium text-kumo-default">{authorization.title}</div>
      <p className="mt-1 text-kumo-subtle">{authorization.description}</p>
      <WorkshopButton
        className="mt-2"
        disabled={pending}
        onClick={() => void requestAuthorization()}
      >
        {authorization.title}
      </WorkshopButton>
      {message && <p className="mt-2 text-kumo-subtle" aria-live="polite">{message}</p>}
    </section>
  )
}
