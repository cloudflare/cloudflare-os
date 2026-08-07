import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Input } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { SeatCompleteResult, SeatProvider, SeatStartResult } from '@gadgets/workshop-shared/seat-types'

interface SeatSignInButtonsProps {
  authenticatedApi: RpcStub<AuthenticatedApi>
  // Fires once enrollment succeeds. The handle is a bearer credential for the user's
  // subscription — callers must store it, never display it.
  onEnrolled: (provider: SeatProvider, handle: string, models: string[], apiUrl: string) => void
}

const PROVIDER_LABELS: Record<SeatProvider, string> = {
  anthropic: 'Sign in with Claude subscription',
  openai: 'Sign in with ChatGPT subscription',
}

// Where the walkthrough currently is. `idle`/`starting` show the two provider buttons;
// `authorize_url` and `device_code` mirror the two shapes `startSeatAuth` can return.
type Step =
  | { kind: 'idle' }
  | { kind: 'starting', provider: SeatProvider }
  | { kind: 'authorize_url', provider: SeatProvider, enrollId: string, url: string }
  | {
      kind: 'device_code', provider: SeatProvider, enrollId: string,
      userCode: string, verificationUri: string, interval: number,
    }

// Walks the user through enrolling an AI-subscription seat: pick a provider, open its consent
// flow, then either paste back the code (Anthropic) or wait while we poll (OpenAI). Never renders
// the resulting handle — it's a bearer credential, so it only ever flows up via `onEnrolled`.
export default function SeatSignInButtons({ authenticatedApi, onEnrolled }: SeatSignInButtonsProps) {
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const finish = (result: SeatCompleteResult, provider: SeatProvider): boolean => {
    if (result.status !== 'complete') return false
    onEnrolled(provider, result.handle, result.models, result.apiUrl)
    setStep({ kind: 'idle' })
    setCode('')
    setError(null)
    return true
  }

  const start = async (provider: SeatProvider) => {
    setError(null)
    setCode('')
    setStep({ kind: 'starting', provider })
    try {
      const result: SeatStartResult = await authenticatedApi.startSeatAuth(provider)
      if (!mountedRef.current) return
      setStep(result.kind === 'authorize_url'
        ? { kind: 'authorize_url', provider, enrollId: result.enrollId, url: result.url }
        : {
            kind: 'device_code', provider, enrollId: result.enrollId,
            userCode: result.userCode, verificationUri: result.verificationUri, interval: result.interval,
          })
    } catch (err) {
      if (!mountedRef.current) return
      setStep({ kind: 'idle' })
      setError(err instanceof Error ? err.message : 'Could not start sign-in. Please try again.')
    }
  }

  const submitCode = async () => {
    if (step.kind !== 'authorize_url') return
    setSubmitting(true)
    setError(null)
    try {
      const result = await authenticatedApi.completeSeatAuth(step.provider, step.enrollId, code.trim())
      if (!mountedRef.current) return
      if (!finish(result, step.provider)) {
        setError('That code was not accepted. Please try again.')
      }
    } catch (err) {
      if (!mountedRef.current) return
      setError(err instanceof Error ? err.message : 'That code was not accepted. Please try again.')
    } finally {
      if (mountedRef.current) setSubmitting(false)
    }
  }

  // Poll for OpenAI's device-code completion on the interval the proxy asked for. Stops on
  // success, on unmount — critically, so a leaked interval can't keep firing RPCs after the
  // component is gone — and on 3 CONSECUTIVE failures. The user is typically off in another tab
  // approving the request, so a single transient network blip must not end the flow.
  const MAX_CONSECUTIVE_POLL_FAILURES = 3
  const pollInFlightRef = useRef(false)
  const polling = step.kind === 'device_code' ? step : null
  useEffect(() => {
    if (!polling) return
    const { provider, enrollId, interval } = polling
    pollInFlightRef.current = false
    let consecutiveFailures = 0
    const id = setInterval(async () => {
      // Skip this tick if the previous call is still outstanding — otherwise a round trip slower
      // than `interval` lets ticks overlap, and two concurrent "complete" responses could both
      // reach finish()/onEnrolled.
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        const result = await authenticatedApi.completeSeatAuth(provider, enrollId)
        if (!mountedRef.current) return
        consecutiveFailures = 0
        if (result.status === 'complete') {
          clearInterval(id)
          finish(result, provider)
        }
      } catch (err) {
        consecutiveFailures += 1
        if (consecutiveFailures < MAX_CONSECUTIVE_POLL_FAILURES) return
        clearInterval(id)
        if (!mountedRef.current) return
        setStep({ kind: 'idle' })
        setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.')
      } finally {
        pollInFlightRef.current = false
      }
    }, interval * 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling?.enrollId])

  const busy = step.kind === 'starting'

  return (
    <div className="space-y-3">
      {error && <Banner variant="error" title={error} />}

      {(step.kind === 'idle' || step.kind === 'starting') && (
        <div className="space-y-3">
          <div className="space-y-2">
            {(Object.keys(PROVIDER_LABELS) as SeatProvider[]).map((provider) => (
              <Button
                key={provider}
                variant="secondary"
                className="w-full justify-center"
                onClick={() => start(provider)}
                loading={busy && step.kind === 'starting' && step.provider === provider}
                disabled={busy}
              >
                {PROVIDER_LABELS[provider]}
              </Button>
            ))}
          </div>
          <p className="text-xs text-kumo-subtle">
            Heads up: the consent screen will show the app name "Claude Code" — that's expected
            for this sign-in flow, not a sign anything's wrong.
          </p>
        </div>
      )}

      {step.kind === 'authorize_url' && (
        <div className="space-y-3">
          <p className="text-sm">
            <a
              href={step.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-kumo-brand underline"
            >
              Open the sign-in page
            </a>
            {' '}and approve access. It will show you a code — come back and paste it below.
          </p>
          <Input
            label="Code from the sign-in page"
            description={'Paste the whole value, including the "#" and everything after it.'}
            placeholder="code#state"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={submitCode}
              loading={submitting}
              disabled={!code.trim()}
            >
              Complete sign-in
            </Button>
            <Button variant="secondary" onClick={() => setStep({ kind: 'idle' })} disabled={submitting}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {step.kind === 'device_code' && (
        <div className="space-y-3">
          <p className="text-sm">
            Go to{' '}
            <a
              href={step.verificationUri}
              target="_blank"
              rel="noopener noreferrer"
              className="text-kumo-brand underline"
            >
              {step.verificationUri}
            </a>
            {' '}and enter this code:
          </p>
          <p className="text-lg font-mono font-semibold tracking-wide">{step.userCode}</p>
          <p className="text-xs text-kumo-subtle">Waiting for you to finish signing in…</p>
          <Button variant="secondary" onClick={() => setStep({ kind: 'idle' })}>Cancel</Button>
        </div>
      )}
    </div>
  )
}
