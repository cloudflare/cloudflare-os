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
  const requestId = useRef(0)
  const blankPopup = useRef<Window | null>(null)

  useEffect(() => () => {
    requestId.current++
    blankPopup.current?.close()
    blankPopup.current = null
  }, [])

  const requestAuthorization = async () => {
    const popup = window.open('about:blank', AUTHORIZATION_WINDOW_NAME)
    if (!popup) {
      setMessage('Allow popups and try again.')
      return
    }

    popup.opener = null
    const currentRequest = ++requestId.current
    blankPopup.current = popup
    setPending(true)
    setMessage(null)

    try {
      const result = await authorization.request()
      if (currentRequest !== requestId.current) return

      if (!result.url) {
        popup.close()
        blankPopup.current = null
        setMessage('Access is already available. Retry the shared-drive selector below.')
        return
      }

      const url = new URL(result.url)
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
        throw new Error('Invalid authorization URL')
      }

      popup.location.replace(url.href)
      blankPopup.current = null
      setMessage('Complete authorization in the new tab, then return and retry the shared-drive selector below.')
    } catch {
      if (currentRequest !== requestId.current) return
      popup.close()
      blankPopup.current = null
      setMessage('Could not start authorization. Please try again.')
    } finally {
      if (currentRequest === requestId.current) setPending(false)
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
