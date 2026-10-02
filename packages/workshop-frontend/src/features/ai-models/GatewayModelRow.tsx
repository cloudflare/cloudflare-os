import { Badge, Button, Radio } from '@cloudflare/kumo'
import { GATEWAY_MODEL_MODES } from '@gadgets/workshop-shared/api'
import type { AdminModel, GatewayModelMode } from '@gadgets/workshop-shared/api'
import { PROVIDER_LABELS } from './modelForm'

/** Each mode's name and what it does to a model, as the Models tab words them. */
export const MODES: Record<GatewayModelMode, { label: string; meaning: string }> = {
  enabled: { label: 'Enabled', meaning: 'Offered in model pickers.' },
  hidden: {
    label: 'Hidden',
    meaning: 'Not offered in model pickers, but still works where it is already in use.',
  },
  disabled: {
    label: 'Disabled',
    meaning:
      'Not offered in model pickers, and stops working, including in the chats and gadgets that ' +
      'already use it.',
  },
}

const tokenCount = (tokens: number) => `${tokens.toLocaleString()} tokens`

/** One gateway model in the Models tab: what it is, and the controls that change it. */
export const GatewayModelRow = ({ model, busy, onModeChange, onRemove }: {
  model: AdminModel
  busy: boolean
  onModeChange: (mode: GatewayModelMode) => void
  /** Present for a model that can be removed, whose row then also names its provider. */
  onRemove?: () => void
}) => (
  <li className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5">
    <div className="min-w-0 flex-1 basis-56">
      <p className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-kumo-default">{model.name}</span>
        {model.mode !== model.defaultMode && <Badge variant="outline">Changed</Badge>}
      </p>
      <p className="mt-0.5 break-all font-mono text-xs text-kumo-subtle">{model.id}</p>
      <p className="mt-0.5 text-xs text-kumo-subtle">
        {onRemove && `${PROVIDER_LABELS[model.provider]} · `}
        Context window: {tokenCount(model.contextWindow)}
        {model.outputLimit !== undefined && ` · Output limit: ${tokenCount(model.outputLimit)}`}
      </p>
    </div>

    <Radio.Group<GatewayModelMode>
      orientation="horizontal"
      value={model.mode}
      disabled={busy}
      onValueChange={onModeChange}
    >
      <Radio.Legend className="sr-only">How {model.name} is offered</Radio.Legend>
      {GATEWAY_MODEL_MODES.map((mode) => (
        <Radio.Item<GatewayModelMode>
          key={mode}
          value={mode}
          disabled={busy}
          label={
            <span title={MODES[mode].meaning}>
              {MODES[mode].label}
              {mode === model.defaultMode && <span className="text-kumo-subtle"> (default)</span>}
            </span>
          }
        />
      ))}
    </Radio.Group>

    {onRemove && (
      <Button
        variant="secondary"
        size="sm"
        disabled={busy}
        aria-label={`Remove ${model.name}`}
        onClick={onRemove}
      >
        Remove
      </Button>
    )}
  </li>
)
