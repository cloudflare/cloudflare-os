import { ArrowDownIcon, ArrowUpIcon, DotsThreeIcon, FlaskIcon } from '@phosphor-icons/react'
import type { AdminGatewayProvider } from '@gadgets/workshop-shared/api'
import { DropdownMenu, LIST_ACTION, SettingRow, Switch } from '@gadgets/ui'
import { GatewayTestStatus } from './GatewayTest'
import { PROVIDER_LABELS } from './modelForm'
import type { GatewayTestState } from './useGatewayTests'

export type GatewayProviderRowProps = {
  entry: AdminGatewayProvider
  /** A change to the models is under way, which the switch waits for. */
  busy: boolean
  /** Where its last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  onEnabledChange: (enabled: boolean) => void
  /** Moves it one place along the providers, where it is not at that end already. */
  onMoveUp?: () => void
  onMoveDown?: () => void
  onTest: () => void
}

/**
 * One provider AI Gateway serves, as a setting: its switch, which one the deployment's
 * `CF_AI_GATEWAY_PROVIDERS` turns on cannot change, and more, which tests whether it answers and
 * moves it along the order the models are listed in. A provider the gateway needs a token for
 * says so, and what a test found is under its name.
 */
export const GatewayProviderRow = ({ entry, busy, test, onEnabledChange, onMoveUp, onMoveDown, onTest }: GatewayProviderRowProps) => {
  const label = PROVIDER_LABELS[entry.provider]
  const locked = entry.enabledBy === 'environment'
  return (
    <SettingRow
      title={label}
      description={(
        <>
          {locked && <span className="block">Set by <code className="font-mono">CF_AI_GATEWAY_PROVIDERS</code>.</span>}
          {entry.needsApiToken && <span className="block text-kumo-danger">Needs <code className="font-mono">CF_AI_GATEWAY_API_TOKEN</code>: requests to it fail until the deployment sets it.</span>}
          <GatewayTestStatus test={test} subject="provider" />
        </>
      )}
    >
      <Switch aria-label={label} checked={entry.enabledBy !== undefined} disabled={locked} busy={busy} onCheckedChange={onEnabledChange} />
      <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${label}`} triggerVariant="ghost" triggerClassName={LIST_ACTION} align="end">
        <DropdownMenu.Item icon={FlaskIcon} disabled={test?.state === 'testing'} onSelect={onTest}>Test</DropdownMenu.Item>
        <DropdownMenu.Item icon={ArrowUpIcon} disabled={!onMoveUp} onSelect={onMoveUp}>Move up</DropdownMenu.Item>
        <DropdownMenu.Item icon={ArrowDownIcon} disabled={!onMoveDown} onSelect={onMoveDown}>Move down</DropdownMenu.Item>
      </DropdownMenu>
    </SettingRow>
  )
}
