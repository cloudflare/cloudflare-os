import type { ReactNode } from 'react'
import type { GatewayModelLevelTest, GatewayModelTest } from '@gadgets/workshop-shared/api'
import { REASONING_LEVEL_LABELS } from './modelForm'
import type { GatewayTestState } from './useGatewayTests'

const colourOf = (result: GatewayModelTest) => (result.ok ? 'text-kumo-success' : 'text-kumo-danger')

// What one request found. A provider's test asks one of its models, which a pass names; a pass of
// the Auto Router model names the gateway model that answered.
const wordingOf = (result: GatewayModelTest, subject: 'provider' | 'model'): ReactNode => {
  if (!result.ok) return <>Failed{result.status !== undefined && ` (${result.status})`}: {result.message}</>
  const via = result.routedModel !== undefined && <> via <span className="font-mono">{result.routedModel}</span></>
  return subject === 'provider'
    ? <><span className="font-mono">{result.model}</span> answered through the gateway{via}.</>
    : <>Answered through the gateway{via}.</>
}

// Refused as unauthorized or forbidden, which the hint gives the likely reasons for.
const unauthorized = (result: GatewayModelTest) => !result.ok && (result.status === 401 || result.status === 403)

const UNAUTHORIZED_HINT = (
  <span className="block text-kumo-subtle">
    The gateway may hold no key or credits for this provider, or <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code> may not be allowed to run models.
  </span>
)

/**
 * What a test through the gateway answered, as a line under what was tested. It is there, empty,
 * before any test is run, so that the answer is announced as it comes.
 */
export const GatewayTestStatus = ({ test, subject }: {
  /** Where the last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  /** What it was of: a provider's test asks one of its models, which a pass names. */
  subject: 'provider' | 'model'
}) => (
  <span role="status" className="block text-sm wrap-anywhere empty:hidden">
    {test?.state === 'testing' && <span className="block text-kumo-subtle">Testing…</span>}
    {test?.state === 'answered' && (
      <>
        <span className={`block ${colourOf(test.result)}`}>{wordingOf(test.result, subject)}</span>
        {unauthorized(test.result) && UNAUTHORIZED_HINT}
      </>
    )}
    {test?.state === 'not-run' && <span className="block text-kumo-danger">Couldn’t run the test: {test.reason}</span>}
  </span>
)

/**
 * What the test of a model described for adding answered at each of its reasoning levels: a line
 * a request, in the order the server gave them, each under the level it asked for.
 */
export const GatewayLevelTestsStatus = ({ test }: { test: GatewayTestState<GatewayModelLevelTest[]> | undefined }) => (
  <div role="status" className="text-sm wrap-anywhere empty:hidden">
    {test?.state === 'testing' && <p className="text-kumo-subtle">Testing…</p>}
    {test?.state === 'answered' && (
      <>
        <ul className="flex flex-col gap-1">
          {test.result.map((result) => (
            <li key={result.reasoning ?? 'none'} className={colourOf(result)}>
              <span className="font-medium text-kumo-default">{result.reasoning === null ? 'No level set' : REASONING_LEVEL_LABELS[result.reasoning]}</span>: {wordingOf(result, 'model')}
            </li>
          ))}
        </ul>
        {test.result.some(unauthorized) && UNAUTHORIZED_HINT}
      </>
    )}
    {test?.state === 'not-run' && <p className="text-kumo-danger">Couldn’t run the test: {test.reason}</p>}
  </div>
)
