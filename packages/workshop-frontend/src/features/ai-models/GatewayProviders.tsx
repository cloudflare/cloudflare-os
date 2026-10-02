import { useEffect, useId, useRef, useState } from 'react'
import { Banner, Button, Switch } from '@cloudflare/kumo'
import type {
  AdminGatewayProvider,
  AiModelProvider,
  GatewayProviderTest,
} from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { PROVIDER_LABELS } from './modelForm'

// Where a provider's test stands: in flight, answered by the server (a request that failed is an
// answer too), or not run, because the call for it failed.
type ProviderTest =
  | { state: 'testing' }
  | { state: 'answered'; result: GatewayProviderTest }
  | { state: 'not-run'; reason: string | undefined }

const ProviderRow = ({ entry, busy, test, onEnabledChange, onTest }: {
  entry: AdminGatewayProvider
  busy: boolean
  /** Where the provider's last test stands. Absent until one is run. */
  test: ProviderTest | undefined
  onEnabledChange: (enabled: boolean) => void
  onTest: () => void
}) => {
  const lockedNote = useId()
  const tokenWarning = useId()
  const label = PROVIDER_LABELS[entry.provider]
  const locked = entry.enabledBy === 'environment'
  const testing = test?.state === 'testing'
  const described = [locked && lockedNote, entry.needsApiToken && tokenWarning].filter(Boolean)

  return (
    <li className="rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium text-kumo-default">{label}</p>
          {locked && (
            <p id={lockedNote} className="mt-0.5 text-xs text-kumo-subtle">
              Set by <code className="font-mono">CF_AI_GATEWAY_PROVIDERS</code>
            </p>
          )}
        </div>
        {/* A test in flight leaves the button enabled, because a browser takes focus from a
            button that becomes disabled. A press is ignored until the test answers. */}
        <Button
          variant="secondary"
          size="sm"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label={testing ? `Testing ${label}…` : `Test ${label}`}
          aria-disabled={testing}
          onClick={onTest}
        >
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <Switch
          aria-label={label}
          aria-describedby={described.join(' ') || undefined}
          checked={entry.enabledBy !== undefined}
          disabled={busy || locked}
          onCheckedChange={onEnabledChange}
        />
      </div>
      {entry.needsApiToken && (
        <Banner
          id={tokenWarning}
          className="mt-2"
          variant="alert"
          size="sm"
          description={
            <>
              Needs <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code>: requests to this
              provider fail until the deployment sets it.
            </>
          }
        />
      )}
      {/* Always here, and empty until a test answers, so that the answer is announced. */}
      <div role="status" className="break-words text-xs leading-4">
        {test?.state === 'answered' && (test.result.ok ? (
          <p className="mt-2 text-kumo-success">
            <span className="font-mono">{test.result.model}</span> answered through the gateway.
          </p>
        ) : (
          <>
            <p className="mt-2 text-kumo-danger">
              Failed{test.result.status !== undefined && ` (${test.result.status})`}:{' '}
              {test.result.message}
            </p>
            {(test.result.status === 401 || test.result.status === 403) && (
              <p className="mt-1 text-kumo-subtle">
                The gateway may hold no key or credits for this provider, or{' '}
                <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code> may not be allowed to
                run models.
              </p>
            )}
          </>
        ))}
        {test?.state === 'not-run' && (
          <p className="mt-2 text-kumo-danger">
            Couldn’t run the test{test.reason === undefined ? '.' : `: ${test.reason}`}
          </p>
        )}
      </div>
    </li>
  )
}

/**
 * The providers AI Gateway serves, each with the switch that turns it on for the deployment and a
 * test of whether it answers. The tests belong to this list rather than to the server: one runs
 * whatever else the Models tab is doing, and its result stays until the provider is tested again.
 */
export const GatewayProviders = ({ providers, busy, onEnabledChange, onTest }: {
  /** Every provider the gateway serves, on or off, in the order they are listed in. */
  providers: readonly AdminGatewayProvider[]
  /** Whether the switches are locked, because a write to the models is in flight. */
  busy: boolean
  onEnabledChange: (provider: AiModelProvider, enabled: boolean) => void
  /**
   * Asks one of the provider's models through the gateway. A request that fails is a result;
   * rejects when the test could not be run at all.
   */
  onTest: (provider: AiModelProvider) => Promise<GatewayProviderTest>
}) => {
  const [tests, setTests] = useState<Partial<Record<AiModelProvider, ProviderTest>>>({})
  // A test that fails once the list is gone is not reported. Leaving the admin page disposes of
  // the capability the test was asked through, so such a test often fails for that reason alone.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // One test per provider at a time, so an earlier test can't answer over a later one.
  const runTest = async (provider: AiModelProvider) => {
    if (tests[provider]?.state === 'testing') return
    const show = (test: ProviderTest) => setTests((shown) => ({ ...shown, [provider]: test }))
    show({ state: 'testing' })
    try {
      const result = await onTest(provider)
      show({ state: 'answered', result })
    } catch (err) {
      if (!mounted.current) return
      console.error(`Failed to test ${provider} through the gateway:`, err)
      show({ state: 'not-run', reason: rpcFailureDescription(err) })
    }
  }

  return (
    <>
      <p className="mb-2 text-sm text-kumo-subtle">
        The providers whose models this deployment can offer through its AI Gateway. The ones
        listed in <code className="font-mono text-xs">CF_AI_GATEWAY_PROVIDERS</code> are always on;
        the others can be turned on here. Provider keys or credits are stored in the gateway, where
        this page cannot see them, so use Test to find out whether a provider answers.
      </p>
      <ul className="flex flex-col gap-2">
        {providers.map((entry) => (
          <ProviderRow
            key={entry.provider}
            entry={entry}
            busy={busy}
            test={tests[entry.provider]}
            onEnabledChange={(enabled) => onEnabledChange(entry.provider, enabled)}
            onTest={() => { void runTest(entry.provider) }}
          />
        ))}
      </ul>
    </>
  )
}
