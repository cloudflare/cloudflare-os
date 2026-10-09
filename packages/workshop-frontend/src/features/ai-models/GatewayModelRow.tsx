import { useId, useRef, useState, type FormEvent } from 'react'
import { Badge, Button, Collapsible, Input, Radio, Select } from '@cloudflare/kumo'
import { COMPACTION_TRIGGER_RATIO, GATEWAY_MODEL_MODES } from '@gadgets/workshop-shared/api'
import type {
  AdminModelView,
  GatewayModelCapabilities,
  GatewayModelMode,
  GatewayModelSettings,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'
import { GatewayTestButton, GatewayTestStatus } from './GatewayTest'
import {
  PROVIDER_LABELS,
  REASONING_LEVEL_LABELS,
  builtInReasoningLabel,
  parseTokenLimit,
} from './modelForm'
import { useFieldErrorAlert } from './useFieldErrorAlert'
import type { GatewayTestState } from './useGatewayTests'

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

// The reasoning select's value for a model with no level of its own.
const DEPLOYMENT_DEFAULT = 'default'

// A compaction budget under this many tokens is pointed out, since nothing refuses it.
const SMALL_BUDGET = 100_000

const tokenCount = (tokens: number) => `${tokens.toLocaleString()} tokens`

// What is stated of an added model, each fact as its row words it. Empty where nothing is.
const statedFacts = ({ imageInput, reasoningLevels }: GatewayModelCapabilities = {}): string[] => {
  const facts: string[] = []
  if (imageInput !== undefined) facts.push(imageInput ? 'takes images' : 'takes no images')
  if (reasoningLevels !== undefined) {
    const levels = reasoningLevels.map((level) => REASONING_LEVEL_LABELS[level]).join(', ')
    // A list with no level above Off states a model that does no reasoning.
    facts.push(
      reasoningLevels.some((level) => level !== 'off') ? `reasoning levels ${levels}` : 'no reasoning')
  }
  return facts
}

// A write replaces the whole of a model's settings, so each one sends them as they should be
// afterwards: what the server holds with `change` applied, less the fields that leaves unset.
const settingsWith = (
  model: AdminModelView,
  change: GatewayModelSettings,
): GatewayModelSettings => {
  const { reasoning, compactionInputBudget } = { ...model.settings, ...change }
  // The server refuses a budget over the maximum, which a budget stored under a larger context
  // window can be. It goes along at the maximum, where the server caps it when a chat runs, and
  // not at all for a model whose window leaves a prompt no room.
  const budget = Math.min(compactionInputBudget ?? 0, model.maxCompactionInputBudget)
  return {
    ...(reasoning !== undefined && { reasoning }),
    ...(budget > 0 && { compactionInputBudget: budget }),
  }
}

/** One gateway model in the Models tab: what it is, and the controls that change it. */
export const GatewayModelRow = ({
  model, defaultReasoning, behavesLikeName, busy, test, onModeChange, onSettingsChange, onTest,
  onRemove,
}: {
  model: AdminModelView
  /** The deployment's default reasoning level, or null while it sets none. */
  defaultReasoning: ReasoningLevel | null
  /** The catalog's name for the model that `model.behavesLike` names, where the catalog has it. */
  behavesLikeName?: string
  busy: boolean
  /** Where the model's last test stands. Absent until one is run. */
  test: GatewayTestState | undefined
  onModeChange: (mode: GatewayModelMode) => void
  /** Called with the whole of the model's settings, as a change to one of them leaves them. */
  onSettingsChange: (settings: GatewayModelSettings) => void
  /** Asks for the model to be tested. A test is not a write, so `busy` does not hold it back. */
  onTest: () => void
  /** Present for a model that can be removed, whose row then also names its provider. */
  onRemove?: () => void
}) => {
  // What is typed into the budget field, or null while the field shows the server's budget.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const budgetRef = useRef<HTMLInputElement>(null)
  const budgetFacts = useId()
  const budgetAlert = useFieldErrorAlert()

  const stated = statedFacts(model.capabilities)
  const ownLevel = model.settings?.reasoning
  const levelInEffect = ownLevel ?? defaultReasoning
  const takesLevels = model.reasoningLevels.length > 0
  const levelNote = !takesLevels
    ? 'This model takes no reasoning levels, so none is sent to it.'
    : levelInEffect !== null && !model.reasoningLevels.includes(levelInEffect)
      ? `This model has no “${REASONING_LEVEL_LABELS[levelInEffect]}” level. A request asks for ` +
        'the nearest level it has, which is decided when the request is made.'
      : undefined
  // With no deployment default, the option names what the model is then asked for.
  const deploymentDefault = `Deployment default (${
    defaultReasoning
      ? REASONING_LEVEL_LABELS[defaultReasoning]
      : `built-in: ${builtInReasoningLabel(model.builtInReasoning)}`
  })`

  const maxBudget = model.maxCompactionInputBudget
  const ownBudget = model.settings?.compactionInputBudget
  const budgetText = budgetDraft ?? String(ownBudget ?? '')
  const budget = parseTokenLimit(budgetText)
  const budgetError =
    budget === null
      ? 'Enter a positive whole number of tokens, or leave this blank for the built-in budget'
      : budget !== undefined && budget > maxBudget
        ? `Enter at most ${tokenCount(maxBudget)}`
        : undefined
  const smallBudget = typeof budget === 'number' && !budgetError && budget < SMALL_BUDGET
  // The server caps a stored budget at the maximum, which a smaller context window can lower.
  const budgetInEffect = Math.min(ownBudget ?? model.builtInCompactionInputBudget, maxBudget)

  const editBudget = (draft: string | null) => {
    setBudgetDraft(draft)
    budgetAlert.clear()
  }

  const saveBudget = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (budgetError !== undefined) {
      budgetAlert.pointAt(budgetRef.current, budgetError)
      return
    }
    editBudget(null)
    const saved = budget ?? undefined
    if (saved !== ownBudget) {
      onSettingsChange(settingsWith(model, { compactionInputBudget: saved }))
    }
  }

  const resetBudget = () => {
    editBudget(null)
    // The button leaves with the budget it resets, so focus moves to the field first.
    budgetRef.current?.focus()
    onSettingsChange(settingsWith(model, { compactionInputBudget: undefined }))
  }

  return (
    <li className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2.5">
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-words text-sm font-medium text-kumo-default">{model.name}</span>
          {(model.mode !== model.defaultMode || model.settings !== undefined) && (
            <Badge variant="outline">Changed</Badge>
          )}
        </p>
        <p className="mt-0.5 break-all font-mono text-xs text-kumo-subtle">{model.id}</p>
        <p className="mt-0.5 text-xs text-kumo-subtle">
          {onRemove && `${PROVIDER_LABELS[model.provider]} · `}
          Context window: {tokenCount(model.contextWindow)}
          {model.outputLimit !== undefined && ` · Output limit: ${tokenCount(model.outputLimit)}`}
        </p>
        {model.behavesLike !== undefined && (
          <p className="mt-0.5 text-xs text-kumo-subtle">
            Behaves like{' '}
            {behavesLikeName ?? <span className="break-all font-mono">{model.behavesLike}</span>}
            {model.runtimeKnown
              ? '. Not used: this version knows this model itself.'
              : model.behavesLikeKnown === false
                && '. This version no longer knows that model, so nothing is borrowed.'}
          </p>
        )}
        {stated.length > 0 && (
          <p className="mt-0.5 text-xs text-kumo-subtle">
            Stated: {stated.join(' · ')}
            {model.runtimeKnown && '. Not used: this version knows this model itself.'}
          </p>
        )}
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

      <GatewayTestButton name={model.name} testing={test?.state === 'testing'} onTest={onTest} />

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

      {/* The test's result brings its own space above it, so this line takes margins in place of
          the row's gap: an empty status then takes no room above the Settings. */}
      <div className="-mt-2 min-w-0 basis-full">
        <GatewayTestStatus test={test} subject="model" />
        <Collapsible.Root className="mt-2">
          <Collapsible.DefaultTrigger className="w-fit text-sm">
            Settings<span className="sr-only"> for {model.name}</span>
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <div className="grid items-start gap-4 sm:grid-cols-2">
              {/* A level stored for a model that takes none can still be cleared. */}
              {takesLevels || ownLevel !== undefined ? (
                <Select<ReasoningLevel | typeof DEPLOYMENT_DEFAULT>
                  label="Reasoning level"
                  aria-label={`Reasoning level for ${model.name}`}
                  description={levelNote}
                  className="w-full"
                  disabled={busy}
                  value={ownLevel ?? DEPLOYMENT_DEFAULT}
                  onValueChange={(level, { reason }) => {
                    // Only a pick is the admin's. The select also reports changes of its own: to
                    // the value it started with, when its options change under a level that is
                    // not one of them, and to an option whose first letter is typed while it is
                    // closed.
                    if (reason !== 'item-press') return
                    if (!level || level === (ownLevel ?? DEPLOYMENT_DEFAULT)) return
                    onSettingsChange(settingsWith(model, {
                      reasoning: level === DEPLOYMENT_DEFAULT ? undefined : level,
                    }))
                  }}
                  renderValue={(level) =>
                    level === DEPLOYMENT_DEFAULT ? deploymentDefault : REASONING_LEVEL_LABELS[level]}
                >
                  <Select.Option value={DEPLOYMENT_DEFAULT}>{deploymentDefault}</Select.Option>
                  {model.reasoningLevels.map((level) => (
                    <Select.Option key={level} value={level}>
                      {REASONING_LEVEL_LABELS[level]}
                    </Select.Option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm leading-snug text-kumo-subtle">{levelNote}</p>
              )}

              {maxBudget > 0 && (
                <form noValidate onSubmit={saveBudget} className="grid content-start gap-2">
                  <Input
                    ref={budgetRef}
                    label={<>Compaction budget<span className="sr-only"> for {model.name}</span></>}
                    inputMode="numeric"
                    placeholder={`${model.builtInCompactionInputBudget.toLocaleString()} (built-in)`}
                    value={budgetText}
                    disabled={busy}
                    onChange={(event) => editBudget(event.target.value)}
                    error={budgetError}
                    aria-invalid={budgetError !== undefined}
                    aria-describedby={budgetFacts}
                  />
                  {/* The warning is part of the description, and not a live region that would
                      speak while the budget is being typed. */}
                  <div id={budgetFacts} className="grid gap-2 text-sm leading-snug text-kumo-subtle">
                    <p>
                      Leave blank for the built-in budget of{' '}
                      {tokenCount(model.builtInCompactionInputBudget)}. The maximum is{' '}
                      {tokenCount(maxBudget)}. A chat on this model compacts at about{' '}
                      {tokenCount(Math.round(COMPACTION_TRIGGER_RATIO * budgetInEffect))}.
                    </p>
                    {smallBudget && (
                      <p className="text-kumo-warning">
                        A budget under {tokenCount(SMALL_BUDGET)} makes a chat compact very often.
                      </p>
                    )}
                  </div>
                  {budgetAlert.alert}
                  <div className="flex gap-2">
                    <Button
                      type="submit"
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      aria-label={`Save the compaction budget of ${model.name}`}
                    >
                      Save
                    </Button>
                    {ownBudget !== undefined && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`Reset the compaction budget of ${model.name}`}
                        onClick={resetBudget}
                      >
                        Reset
                      </Button>
                    )}
                  </div>
                </form>
              )}
            </div>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </div>
    </li>
  )
}
