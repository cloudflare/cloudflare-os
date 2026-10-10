import { Button } from '@cloudflare/kumo'
import { useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

const STATE_PARAMETER = 'cfos_native_state'
const KEY_PARAMETER = 'cfos_native_key'
const OPAQUE_STATE = /^[A-Za-z0-9._~-]{16,512}$/
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/

export type DeviceSessionAttempt = { state: string; publicKey: string }

/** Parse the native app's bounded opaque state and unpadded P-256 public key. */
export const deviceSessionAttempt = (search: string): DeviceSessionAttempt | null => {
  const params = new URLSearchParams(search)
  const states = params.getAll(STATE_PARAMETER)
  const keys = params.getAll(KEY_PARAMETER)
  if (states.length !== 1 || !OPAQUE_STATE.test(states[0]) || keys.length !== 1 ||
      !PUBLIC_KEY.test(keys[0])) return null
  return { state: states[0], publicKey: keys[0] }
}

/** Whether a URL is trying to start a device session, including a malformed attempt. */
export const hasDeviceSessionParameters = (search: string): boolean => {
  const params = new URLSearchParams(search)
  return params.has(STATE_PARAMETER) || params.has(KEY_PARAMETER)
}

/** Keep only a validated device-session attempt when navigating between authentication pages. */
export const deviceSessionSearch = (search: string): {
  cfos_native_state?: string
  cfos_native_key?: string
} => {
  const attempt = deviceSessionAttempt(search)
  return attempt ? {
    [STATE_PARAMETER]: attempt.state,
    [KEY_PARAMETER]: attempt.publicKey,
  } : {}
}

/** Build an authentication destination without forwarding unrelated or invalid search data. */
export const deviceSessionDestination = (pathname: string, search: string): string => {
  const preserved = deviceSessionSearch(search)
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(preserved)) params.set(name, value)
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

/** Navigate the browser through the single-use callback without exposing its response to script. */
export const submitDeviceSession = (state: string, handoffId: string): void => {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/api/device-session/callback'
  form.style.display = 'none'
  for (const [name, value] of Object.entries({ state, handoffId })) {
    const input = document.createElement('input')
    input.name = name
    input.value = value
    form.append(input)
  }
  document.body.append(form)
  try {
    form.submit()
  } finally {
    form.remove()
  }
}

/** Ask the user before transferring an install session to the native Cloudflare OS app. */
export const DeviceSessionHandoff = ({
  authenticatedApi,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
}) => {
  const attempt = deviceSessionAttempt(window.location.search)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const continueInApp = async () => {
    if (!attempt || working) return
    setWorking(true)
    setError(null)
    try {
      const { handoffId } = await authenticatedApi.beginDeviceSessionHandoff(
        attempt.publicKey,
        attempt.state,
      )
      submitDeviceSession(attempt.state, handoffId)
    } catch {
      setError('Could not prepare this device session. Try again.')
      setWorking(false)
    }
  }

  if (!attempt) {
    return (
      <main className="flex min-h-full items-center justify-center bg-kumo-base p-6">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-lg font-semibold text-kumo-default">Couldn&apos;t start app sign-in</h1>
          <p role="alert" className="text-sm text-kumo-danger">
            This device-session request is invalid. Return to the app and start again.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-kumo-base p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        {working && <div aria-hidden="true" className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />}
        <h1 className="text-lg font-semibold text-kumo-default">
          {working ? 'Finishing sign-in…' : 'Continue in Cloudflare OS?'}
        </h1>
        <p className="text-sm text-kumo-subtle">
          {working
            ? 'This browser will close and return to the app.'
            : 'Continue only if you started this sign-in from the Cloudflare OS app.'}
        </p>
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        {!working && (
          <Button variant="primary" onClick={() => { void continueInApp() }}>
            Continue in Cloudflare OS
          </Button>
        )}
      </div>
    </main>
  )
}
