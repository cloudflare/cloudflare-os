import { useEffect, useRef, useState } from 'react'
import type {
  ResourceConfiguratorAuthorization,
  ResourceConfiguratorFrame,
} from '@gadgets/workshop-shared/gatekeeper'
import { WorkshopButton } from './components/WorkshopControls'
import SandboxedResourceConfigurator from './SandboxedResourceConfigurator'

/** Releases every capability owned by a resource-configurator frame. */
export function disposeConfiguratorFrame(frame: ResourceConfiguratorFrame | null): void {
  if (!frame) return
  try {
    disposeRpcStub(frame.ui)
  } finally {
    disposeRpcStub(frame.authorization?.request)
  }
}

function disposeRpcStub(stub: unknown): void {
  const isObject = typeof stub === 'object' && stub !== null
  if (!isObject && typeof stub !== 'function') return
  if (!(Symbol.dispose in stub)) return
  const dispose = stub[Symbol.dispose]
  if (typeof dispose === 'function') dispose.call(stub)
}

/** Renders the trusted controls and sandboxed resource configurator. */
export default function ResourceConfiguratorHost({
  frame,
  frameKey,
  loading,
  error,
  disabled,
  onCollectResourceUrlChange,
  onSelectionReadyChange,
  topOffset = 0,
  initialResourceUrl,
  resourceUrlPattern,
}: {
  frame: ResourceConfiguratorFrame | null
  frameKey: number | null
  loading: boolean
  error: string | null
  disabled: boolean
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
  onSelectionReadyChange?: (ready: boolean | null) => void
  topOffset?: number
  initialResourceUrl?: string
  resourceUrlPattern?: string
}) {
  if (disabled) return <Placeholder>Choose an account before selecting a resource.</Placeholder>
  if (loading) return <Placeholder>Loading configurator...</Placeholder>
  if (error) return <Placeholder>{error}</Placeholder>
  if (!frame) return null

  return (
    <>
      {frame.authorization && (
        <AuthorizationAction
          key={`authorization:${frameKey}`}
          authorization={frame.authorization}
        />
      )}
      <SandboxedResourceConfigurator
        key={`configurator:${frameKey}`}
        frame={frame}
        topOffset={topOffset}
        onCollectResourceUrlChange={onCollectResourceUrlChange}
        onSelectionReadyChange={onSelectionReadyChange}
        initialResourceUrl={initialResourceUrl}
        resourceUrlPattern={resourceUrlPattern}
      />
    </>
  )
}

function AuthorizationAction({
  authorization,
}: {
  authorization: ResourceConfiguratorAuthorization
}) {
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
    const popup = window.open('about:blank', '_blank')
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

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-3 text-[12px] leading-4 text-kumo-subtle">
      {children}
    </section>
  )
}
