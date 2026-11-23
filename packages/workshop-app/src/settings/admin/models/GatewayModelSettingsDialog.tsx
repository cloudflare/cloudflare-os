import { useState, type FormEvent } from 'react'
import { Cancel01Icon } from '@/components/icons'
import { COMPACTION_TRIGGER_RATIO, type AdminModelView, type AiModelProvider, type GatewayModelSettings, type ReasoningLevel } from '@gadgets/workshop-shared/api'
import { Button, Dialog, Select, TextField } from '@gadgets/ui'
import { AllowedModelsEditor } from './AllowedModelsEditor'
import { builtInReasoningLabel, parseTokenLimit, REASONING_LEVEL_LABELS, settingsWith, tokenCount, type AllowedModelSuggestion } from './modelForm'

// The reasoning menu's choice for a model with no level of its own.
const DEPLOYMENT_DEFAULT = 'default'

// A compaction budget under this many tokens is pointed out, as nothing refuses it.
const SMALL_BUDGET = 100_000

export type GatewayModelSettingsDialogProps = {
  /** The model whose settings are open, as the server last said it, or nothing while none is. */
  model: AdminModelView | undefined
  /** The deployment's default reasoning level, or none while it sets none. */
  defaultReasoning: ReasoningLevel | null
  /** The providers that are on, which the Auto Router model picks among while it lists none. */
  poolProviders: readonly AiModelProvider[]
  /** The gateway names the Auto Router model's allowed models are offered from. */
  poolSuggestions: readonly AllowedModelSuggestion[]
  busy: boolean
  /** Keeps the whole of the model's settings, as a change to one leaves them. Resolves to whether they were kept. */
  onSettingsChange: (settings: GatewayModelSettings) => Promise<boolean>
  onClose: () => void
}

const ModelSettingsForm = ({ model, defaultReasoning, poolProviders, poolSuggestions, busy, onSettingsChange }: Omit<GatewayModelSettingsDialogProps, 'model' | 'onClose'> & { model: AdminModelView }) => {
  // What is typed in the budget's field, or nothing while it shows the server's.
  const [budgetDraft, setBudgetDraft] = useState<string>()
  const ownLevel = model.settings?.reasoning
  const levelInEffect = ownLevel ?? defaultReasoning
  const takesLevels = model.reasoningLevels.length > 0
  const levelNote = !takesLevels
    ? 'This model takes no reasoning levels, so none is sent to it.'
    : levelInEffect !== null && !model.reasoningLevels.includes(levelInEffect)
      ? `This model has no “${REASONING_LEVEL_LABELS[levelInEffect]}” level. A request asks for the nearest level it has, which is decided as it is made.`
      : 'How much the model thinks before the agent’s turns are answered.'
  // With no default of the deployment's, the choice says what the model is then asked for.
  const deploymentDefault = `Deployment default (${defaultReasoning ? REASONING_LEVEL_LABELS[defaultReasoning] : `built-in: ${builtInReasoningLabel(model.builtInReasoning)}`})`

  const maxBudget = model.maxCompactionInputBudget
  const ownBudget = model.settings?.compactionInputBudget
  const budgetText = budgetDraft ?? String(ownBudget ?? '')
  const budget = parseTokenLimit(budgetText)
  const budgetProblem = budget === null
    ? 'Enter a positive whole number of tokens, or leave it empty for the built-in budget.'
    : budget !== undefined && budget > maxBudget ? `Enter at most ${tokenCount(maxBudget)}.` : undefined
  // The server caps a stored budget at the maximum, which a smaller context window can lower.
  const budgetInEffect = Math.min(ownBudget ?? model.builtInCompactionInputBudget, maxBudget)

  const saveBudget = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || budgetProblem !== undefined) return
    const saved = budget ?? undefined
    if (saved === ownBudget || (await onSettingsChange(settingsWith(model, { compactionInputBudget: saved })))) setBudgetDraft(undefined)
  }

  return (
    <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-6 pb-6">
      {/* A level kept for a model that takes none can still be cleared. */}
      {takesLevels || ownLevel !== undefined
        ? (
            <div className="flex flex-col gap-2">
              <p className="font-medium text-kumo-default">Reasoning level</p>
              <Select
                aria-label={`Reasoning level for ${model.name}`}
                value={ownLevel ?? DEPLOYMENT_DEFAULT}
                options={[{ id: DEPLOYMENT_DEFAULT, label: deploymentDefault }, ...model.reasoningLevels.map((level) => ({ id: level, label: REASONING_LEVEL_LABELS[level] }))]}
                onValueChange={(level) => {
                  if (busy || level === (ownLevel ?? DEPLOYMENT_DEFAULT)) return
                  void onSettingsChange(settingsWith(model, { reasoning: level === DEPLOYMENT_DEFAULT ? undefined : level as ReasoningLevel }))
                }}
              />
              <p className="text-sm text-kumo-subtle">{levelNote}</p>
            </div>
          )
        : <p className="text-sm text-kumo-subtle">{levelNote}</p>}
      {maxBudget > 0 && (
        <form noValidate onSubmit={(event) => void saveBudget(event)} className="flex flex-col gap-2">
          <TextField
            label="Compaction budget"
            inputMode="numeric"
            placeholder={`${model.builtInCompactionInputBudget.toLocaleString('en')} (built-in)`}
            value={budgetText}
            invalid={budgetDraft !== undefined && budgetProblem !== undefined}
            onValueChange={setBudgetDraft}
          />
          <p className="text-sm text-kumo-subtle">
            {budgetDraft !== undefined && budgetProblem && <span role="alert" className="block text-kumo-danger">{budgetProblem}</span>}
            Leave it empty for the built-in budget of {tokenCount(model.builtInCompactionInputBudget)}. The maximum is {tokenCount(maxBudget)}. A chat on this model compacts at about {tokenCount(Math.round(COMPACTION_TRIGGER_RATIO * budgetInEffect))}.
            {typeof budget === 'number' && !budgetProblem && budget < SMALL_BUDGET && <span className="block text-kumo-warning">A budget under {tokenCount(SMALL_BUDGET)} makes a chat compact very often.</span>}
          </p>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || budgetDraft === undefined || budgetProblem !== undefined}>Save</Button>
            {ownBudget !== undefined && (
              <Button variant="ghost" disabled={busy} onClick={() => void onSettingsChange(settingsWith(model, { compactionInputBudget: undefined })).then((done) => done && setBudgetDraft(undefined))}>Reset</Button>
            )}
          </div>
        </form>
      )}
      {model.provider === 'cloudflare-auto-router' && (
        <AllowedModelsEditor
          modelName={model.name}
          allowedModels={model.settings?.allowedModels}
          providers={poolProviders}
          suggestions={poolSuggestions}
          busy={busy}
          onSave={(allowedModels) => onSettingsChange(settingsWith(model, { allowedModels }))}
        />
      )}
    </div>
  )
}

/**
 * A gateway model's settings, over the part, each kept as it is changed: its reasoning level, its
 * compaction budget where its window leaves room for one, and, for the Auto Router model, the
 * models it may pick. What the server holds is what is shown, so the dialog is given the model
 * as it was last read.
 */
export const GatewayModelSettingsDialog = ({ model, onClose, ...settings }: GatewayModelSettingsDialogProps) => (
  <Dialog open={model !== undefined} onOpenChange={(open) => { if (!open) onClose() }}>
    {model && (
      <>
        <header className="flex items-start gap-3 p-6 pb-5">
          <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
            <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{model.name}</Dialog.Title>
            <Dialog.Description className="font-mono text-sm wrap-anywhere text-kumo-subtle">{model.id}</Dialog.Description>
          </div>
          <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<Cancel01Icon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
        </header>
        <ModelSettingsForm key={model.id} model={model} {...settings} />
      </>
    )}
  </Dialog>
)
