import { Button } from '@cloudflare/kumo'
import type { GatewayTestState } from './useGatewayTests'

/**
 * The button that runs a gateway test. A test in flight leaves it enabled, because a browser takes
 * focus from a button that becomes disabled; `useGatewayTests` ignores a press until the test
 * answers.
 */
export const GatewayTestButton = ({ name, testing, onTest }: {
  /** What the test is of, which the button's accessible name says. */
  name: string
  testing: boolean
  onTest: () => void
}) => (
  <Button
    variant="secondary"
    size="sm"
    className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    aria-label={testing ? `Testing ${name}…` : `Test ${name}`}
    aria-disabled={testing}
    onClick={() => onTest()}
  >
    {testing ? 'Testing…' : 'Test'}
  </Button>
)

/**
 * What a gateway test answered. The region is rendered before any test is run, and is empty until
 * one answers, so that the answer is announced.
 */
export const GatewayTestStatus = ({ test, subject }: {
  /** Where the last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  /**
   * What the test is of. A provider's test asks one of the provider's models, which a pass names;
   * a model's test asks the model whose row the result is in.
   */
  subject: 'provider' | 'model'
}) => (
  <div role="status" className="break-words text-xs leading-4">
    {test?.state === 'answered' && (test.result.ok ? (
      <p className="mt-2 text-kumo-success">
        {subject === 'provider' ? (
          <><span className="font-mono">{test.result.model}</span> answered through the gateway.</>
        ) : (
          'Answered through the gateway.'
        )}
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
            <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code> may not be allowed to run
            models.
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
)
