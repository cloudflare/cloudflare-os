import { Button } from '@cloudflare/kumo'
import type { GatewayModelLevelTest, GatewayModelTest } from '@gadgets/workshop-shared/api'
import { REASONING_LEVEL_LABELS } from './modelForm'
import type { GatewayTestState } from './useGatewayTests'

/**
 * The button that runs a gateway test. A test in flight leaves it enabled, because a browser takes
 * focus from a button that becomes disabled; `useGatewayTests` ignores a press until the test
 * answers.
 */
export const GatewayTestButton = ({ name, testing, onTest, size = 'sm' }: {
  /** What the test is of, which the button's accessible name says. */
  name: string
  testing: boolean
  onTest: () => void
  /** A row's button is small. One beside a form's submit button is that button's size. */
  size?: 'sm' | 'base'
}) => (
  <Button
    type="button"
    variant="secondary"
    size={size}
    className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
    aria-label={testing ? `Testing ${name}…` : `Test ${name}`}
    aria-disabled={testing}
    onClick={() => onTest()}
  >
    {testing ? 'Testing…' : 'Test'}
  </Button>
)

const STATUS_REGION = 'break-words text-xs leading-4'

const resultColor = (result: GatewayModelTest) =>
  (result.ok ? 'text-kumo-success' : 'text-kumo-danger')

// What one request found, in words. A provider's test asks one of the provider's models, which a
// pass names.
const resultWording = (result: GatewayModelTest, subject: 'provider' | 'model') => {
  if (!result.ok) {
    return <>Failed{result.status !== undefined && ` (${result.status})`}:{' '}{result.message}</>
  }
  return subject === 'provider' ? (
    <><span className="font-mono">{result.model}</span> answered through the gateway.</>
  ) : (
    'Answered through the gateway.'
  )
}

// Whether the request was refused as unauthorized or forbidden, which the hint gives the likely
// reasons for.
const unauthorized = (result: GatewayModelTest) =>
  !result.ok && (result.status === 401 || result.status === 403)

const UnauthorizedHint = () => (
  <p className="mt-1 text-kumo-subtle">
    The gateway may hold no key or credits for this provider, or{' '}
    <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code> may not be allowed to run
    models.
  </p>
)

const NotRun = ({ reason }: { reason: string | undefined }) => (
  <p className="mt-2 text-kumo-danger">
    Couldn’t run the test{reason === undefined ? '.' : `: ${reason}`}
  </p>
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
  <div role="status" className={STATUS_REGION}>
    {test?.state === 'answered' && (
      <>
        <p className={`mt-2 ${resultColor(test.result)}`}>{resultWording(test.result, subject)}</p>
        {unauthorized(test.result) && <UnauthorizedHint />}
      </>
    )}
    {test?.state === 'not-run' && <NotRun reason={test.reason} />}
  </div>
)

/**
 * What the test of a model at each of its reasoning levels answered: a line per request, in the
 * order the server gave them, each under the level it asked for. The region is rendered before
 * any test is run, and is empty until one answers, so that the answer is announced.
 */
export const GatewayLevelTestsStatus = ({ test }: {
  /** Where the last test stands. Absent until one is run. */
  test: GatewayTestState<GatewayModelLevelTest[]> | undefined
}) => (
  <div role="status" className={STATUS_REGION}>
    {test?.state === 'answered' && (
      <>
        <ul className="mt-2 flex flex-col gap-1">
          {test.result.map((result) => (
            <li key={result.reasoning ?? 'none'} className={resultColor(result)}>
              <span className="font-medium text-kumo-default">
                {result.reasoning === null
                  ? 'No level set'
                  : REASONING_LEVEL_LABELS[result.reasoning]}
              </span>
              : {resultWording(result, 'model')}
            </li>
          ))}
        </ul>
        {test.result.some(unauthorized) && <UnauthorizedHint />}
      </>
    )}
    {test?.state === 'not-run' && <NotRun reason={test.reason} />}
  </div>
)
