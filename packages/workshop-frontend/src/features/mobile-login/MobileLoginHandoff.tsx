import { Button } from '@cloudflare/kumo'
import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, MobileHandoff } from '@gadgets/workshop-shared/api'
import { inMobileApp, reportLoginReady } from './mobileAppNavigation'

const STATE_PARAMETER = 'cfos_mobile_state'
const KEY_PARAMETER = 'cfos_mobile_key'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PUBLIC_KEY = /^[A-Za-z0-9_-]{87}$/
const RETRY_DELAY_MS = 8000

/** Parse and validate the native app's one-time state and ephemeral public key. */
export const mobileLoginAttempt = (search: string): { state: string; publicKey: string } | null => {
  const params = new URLSearchParams(search)
  const states = params.getAll(STATE_PARAMETER)
  const keys = params.getAll(KEY_PARAMETER)
  if (states.length !== 1 || !UUID.test(states[0]) || keys.length !== 1 ||
      !PUBLIC_KEY.test(keys[0])) return null
  return { state: states[0], publicKey: keys[0] }
}

/**
 * Post the sealed handoff to this install without putting it in the request URL. The install's
 * backend responds with the custom-scheme redirect that completes native authentication.
 */
export const submitMobileLogin = (state: string, sealed: MobileHandoff): void => {
  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/api/mobile-login/callback'
  form.style.display = 'none'
  for (const [name, value] of Object.entries({ state, ...sealed })) {
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

/** Verify the restored session before offering a sealed transfer to the app's ephemeral key. */
export const MobileLoginHandoff = ({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) => {
  const attempt = mobileLoginAttempt(window.location.search)
  const attemptKey = attempt && `${attempt.state}:${attempt.publicKey}`
  // Cap'n Web stubs are callable, so React state must hold one inside an object.
  const [verified, setVerified] = useState<{ api: RpcStub<AuthenticatedApi>; attemptKey: string } | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<{ attemptKey: string; startedAt: number; handoff: Promise<MobileHandoff> } | null>(null)
  const autoCompleted = useRef<string | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!inMobileApp()) return
    let active = true
    authenticatedApi.whoami().then((user) => {
      if (active && user.type === 'user') {
        reportLoginReady()
      }
    }).catch(() => {})
    return () => { active = false }
  }, [authenticatedApi])

  useEffect(() => () => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
  }, [])

  const showRetryIfStillHere = (message: string) => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current)
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null
      setWorking(false)
      setError(message)
    }, RETRY_DELAY_MS)
  }

  useEffect(() => {
    if (!attempt || !attemptKey) return
    let active = true
    const completeLogin = async () => {
      try {
        const user = await authenticatedApi.whoami()
        if (!active) return
        if (user.type !== 'user') throw new Error('No user session')
        setVerified({ api: authenticatedApi, attemptKey })
        if (autoCompleted.current === attemptKey) return
        setWorking(true)

        // Effect restarts must not mint multiple independent sessions for one install attempt.
        if (request.current?.attemptKey !== attemptKey) {
          request.current = {
            attemptKey,
            startedAt: Date.now(),
            handoff: authenticatedApi.createMobileHandoff(attempt.publicKey, attempt.state),
          }
        }
        const sealed = await request.current.handoff
        if (!active || autoCompleted.current === attemptKey) return
        submitMobileLogin(attempt.state, sealed)
        autoCompleted.current = attemptKey
        // A blocked custom-scheme redirect must leave an explicit recovery action.
        if (active) showRetryIfStillHere('The browser did not close. Try returning to the app again.')
      } catch {
        if (active) {
          request.current = null
          setError('Could not transfer this session automatically. Try again.')
          setWorking(false)
        }
      }
    }
    void completeLogin()
    return () => { active = false }
  }, [authenticatedApi, attemptKey])

  if (!attempt) return null

  const returnToApp = async () => {
    if (working) return
    setWorking(true)
    setError(null)
    try {
      const user = await authenticatedApi.whoami()
      if (user.type !== 'user') throw new Error('No user session')
      const sealed = await (request.current?.attemptKey === attemptKey &&
        Date.now() - request.current.startedAt < 90_000
        ? request.current.handoff
        : authenticatedApi.createMobileHandoff(attempt.publicKey, attempt.state))
      submitMobileLogin(attempt.state, sealed)
      showRetryIfStillHere('The browser did not close. Try returning to the app again.')
    } catch {
      setError('Could not confirm this sign-in. Try again.')
      setWorking(false)
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-kumo-base p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center" role="status">
        {!error && <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />}
        <h1 className="text-lg font-semibold text-kumo-default">Finishing sign-in…</h1>
        <p className="text-sm text-kumo-subtle">This browser will close and return to the app.</p>
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        {error && <Button variant="primary" disabled={working} onClick={() => { void returnToApp() }}>
          {working ? 'Connecting…' : verified?.api === authenticatedApi && verified.attemptKey === attemptKey
            ? 'Return to app' : 'Try again'}
        </Button>}
      </div>
    </main>
  )
}
