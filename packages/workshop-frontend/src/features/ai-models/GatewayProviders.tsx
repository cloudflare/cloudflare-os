import { useId } from 'react'
import { Banner, Switch } from '@cloudflare/kumo'
import type {
  AdminGatewayProvider,
  AiModelProvider,
  GatewayModelTest,
} from '@gadgets/workshop-shared/api'
import { GatewayTestButton, GatewayTestStatus } from './GatewayTest'
import { MoveButtons, rowMove, type RowMove } from './MoveButtons'
import { PROVIDER_LABELS } from './modelForm'
import { useGatewayTests, type GatewayTestState } from './useGatewayTests'

const ProviderRow = ({ entry, busy, test, move, onEnabledChange, onTest }: {
  entry: AdminGatewayProvider
  busy: boolean
  /** Where the provider's last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  move: RowMove
  onEnabledChange: (enabled: boolean) => void
  onTest: () => void
}) => {
  const lockedNote = useId()
  const tokenWarning = useId()
  const label = PROVIDER_LABELS[entry.provider]
  const locked = entry.enabledBy === 'environment'
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
        <GatewayTestButton name={label} testing={test?.state === 'testing'} onTest={onTest} />
        <Switch
          aria-label={label}
          aria-describedby={described.join(' ') || undefined}
          checked={entry.enabledBy !== undefined}
          disabled={busy || locked}
          onCheckedChange={onEnabledChange}
        />
        <MoveButtons name={label} move={move} busy={busy} />
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
      <GatewayTestStatus test={test} subject="provider" />
    </li>
  )
}

/**
 * The providers AI Gateway serves, each with the switch that turns it on for the deployment, a
 * test of whether it answers, and the buttons that move it in the order the models are listed in.
 * The tests belong to this list rather than to the server: one runs whatever else the Models tab
 * is doing, and its result stays until the provider is tested again.
 */
export const GatewayProviders = ({ providers, busy, onEnabledChange, onOrderChange, onTest }: {
  /** Every provider the gateway serves, on or off, in the order they are listed in. */
  providers: readonly AdminGatewayProvider[]
  /** Whether the switches and moves are locked, because a write to the models is in flight. */
  busy: boolean
  onEnabledChange: (provider: AiModelProvider, enabled: boolean) => void
  /** Called with every provider, in the order a move leaves them. */
  onOrderChange: (providers: AiModelProvider[]) => void
  /**
   * Asks one of the provider's models through the gateway. A request that fails is a result;
   * rejects when the test could not be run at all.
   */
  onTest: (provider: AiModelProvider) => Promise<GatewayModelTest>
}) => {
  const { tests, startTest } = useGatewayTests(onTest)

  return (
    <>
      <p className="mb-2 text-sm text-kumo-subtle">
        The providers whose models this deployment can offer through its AI Gateway. The ones
        listed in <code className="font-mono text-xs">CF_AI_GATEWAY_PROVIDERS</code> are always on;
        the others can be turned on here. Provider keys or credits are stored in the gateway, where
        this page cannot see them, so use Test to find out whether a provider answers. The model
        pickers list the providers in this order, and a new user or chat gets the first enabled
        model.
      </p>
      <ul className="flex flex-col gap-2">
        {providers.map((entry, index) => (
          <ProviderRow
            key={entry.provider}
            entry={entry}
            busy={busy}
            test={tests.get(entry.provider)}
            move={rowMove(providers.map(({ provider }) => provider), index, onOrderChange)}
            onEnabledChange={(enabled) => onEnabledChange(entry.provider, enabled)}
            onTest={() => startTest(entry.provider)}
          />
        ))}
      </ul>
    </>
  )
}
