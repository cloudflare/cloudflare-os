// Admin panel for the models a deployment provides through AI Gateway.
//
// The list is the server's: every write is followed by a re-read, and each control shows what the
// server reported rather than what was just chosen.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Select, Switch, useKumoToastManager } from '@cloudflare/kumo'
import { GATEWAY_MODEL_MODES, REASONING_LEVELS } from '@gadgets/workshop-shared/api'
import type {
  AdminApi,
  AdminModel,
  AdminModelView,
  AdminSettingsView,
  AiModelProvider,
  GatewayModelMode,
  GatewayModelSettings,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { AddGatewayModelForm } from './AddGatewayModelForm'
import { GatewayModelRow, MODES } from './GatewayModelRow'
import { GatewayProviders } from './GatewayProviders'
import { rpcFailureDescription } from '../../rpcErrors'
import { PROVIDER_LABELS, REASONING_LEVEL_LABELS } from './modelForm'
import { fetchModelsDev, suggestModels } from './modelsDev'
import { useGatewayTests } from './useGatewayTests'

const CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated p-6'
const GROUP_HEADING = 'mb-2 text-sm font-semibold text-kumo-default'
const USER_MODELS_LABEL = 'Users may add their own models'
const MODELS_DEV_LABEL = 'Suggest models from models.dev'
const DEFAULT_REASONING_LABEL = 'Default reasoning level'

// The default-level select's value while the deployment sets no level.
const BUILT_IN = 'built-in'

// The control that has focus, for a write to give focus back to. A pick in a select is made with
// focus on an option in its list, which closes on the pick, so the select stands in for the option.
// A dialog places focus itself as it closes, so a control in one is left to it.
const focusedControl = () => {
  const focused = document.activeElement
  if (focused?.closest('[role="dialog"]')) return null
  const list = focused?.closest('[role="listbox"]')
  const select = list && Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]'))
    .find((control) => control.getAttribute('aria-controls') === list.id)
  return select ?? (focused instanceof HTMLElement ? focused : null)
}

/** A deployment-wide setting: its name and what it does, beside the control that changes it. */
const SettingRow = ({ label, help, children }: {
  label: string
  /** What the setting does, under the ID that the control is described by. */
  help: { id: string; text: ReactNode }
  children: ReactNode
}) => (
  <div className="mb-4 flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
    <div className="min-w-0 flex-1 text-sm">
      <p className="font-medium text-kumo-default">{label}</p>
      <p id={help.id} className="mt-0.5 text-kumo-subtle">{help.text}</p>
    </div>
    {children}
  </div>
)

const SettingSwitch = ({ label, checked, disabled, onChange, children }: {
  label: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  /** What the setting does, which also describes the switch. */
  children: ReactNode
}) => {
  const help = useId()
  return (
    <SettingRow label={label} help={{ id: help, text: children }}>
      <Switch
        aria-label={label}
        aria-describedby={help}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </SettingRow>
  )
}

const DefaultReasoningSetting = ({ level, disabled, onChange }: {
  /** The deployment's default level, or null while it sets none. */
  level: ReasoningLevel | null
  disabled: boolean
  onChange: (level: ReasoningLevel | null) => void
}) => {
  const help = useId()
  return (
    <SettingRow
      label={DEFAULT_REASONING_LABEL}
      help={{
        id: help,
        text:
          'The reasoning level of the agent’s turns on every model listed here that has no level ' +
          'of its own. Built-in sets none: each model is then asked the way the Workshop asks it ' +
          'by default, which the model’s Settings name. That is Adaptive, where the model decides ' +
          'how much to reason, a fixed level, or no level sent. A level that a model lacks is ' +
          'fitted to the nearest one it has. One-shot calls (titles, summaries, gadget model ' +
          'bindings) are not affected, and neither are the models users added.',
      }}
    >
      <Select<ReasoningLevel | typeof BUILT_IN>
        aria-label={DEFAULT_REASONING_LABEL}
        // Kumo's Select hands its trigger a name and nothing else, so the help reaches it here.
        render={<button aria-describedby={help} />}
        className="w-36 shrink-0"
        disabled={disabled}
        value={level ?? BUILT_IN}
        onValueChange={(value, { reason }) => {
          // Only a pick sets the level, and not a letter typed while the select is closed.
          if (reason !== 'item-press' || !value || value === (level ?? BUILT_IN)) return
          onChange(value === BUILT_IN ? null : value)
        }}
        renderValue={(value) => (value === BUILT_IN ? 'Built-in' : REASONING_LEVEL_LABELS[value])}
      >
        <Select.Option value={BUILT_IN}>Built-in</Select.Option>
        {REASONING_LEVELS.map((option) => (
          <Select.Option key={option} value={option}>{REASONING_LEVEL_LABELS[option]}</Select.Option>
        ))}
      </Select>
    </SettingRow>
  )
}

export const AdminModelsPanel = ({ admin, gatewayModels, onChanged }: {
  admin: RpcStub<AdminApi>
  /** What the server last reported. Absent when the deployment isn't in AI Gateway mode. */
  gatewayModels: AdminSettingsView['gatewayModels']
  /** Re-read the settings after a write, so that the panel shows what the server holds. */
  onChanged: () => Promise<void>
}) => {
  const toasts = useKumoToastManager()
  const [busy, setBusy] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<AdminModel | null>(null)
  const [pendingDisable, setPendingDisable] = useState<AdminModel | null>(null)
  // The models' tests, by model ID. Like a provider's test, one neither takes nor waits for the
  // lock. A write to a model forgets its test, and a write to the default level forgets them all.
  const modelTests = useGatewayTests((modelId: string) => admin.testGatewayModel(modelId))
  // What this panel's one request for the models.dev list settled with: the list, or undefined
  // when the request failed. Null until then.
  const [modelsDev, setModelsDev] = useState<{ list: unknown } | null>(null)
  const modelsDevRequest = useRef<AbortController | null>(null)
  useEffect(() => () => modelsDevRequest.current?.abort(), [])
  // A write disables every control, and a browser takes focus from a control that becomes disabled
  // without giving it back. So the control that had focus when the write began gets it again once
  // the controls are enabled, unless focus has gone elsewhere since. A control that left the
  // document in the meantime takes no focus.
  const focusBeforeWrite = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (busy) return
    if (document.activeElement === document.body) focusBeforeWrite.current?.focus()
    focusBeforeWrite.current = null
  }, [busy])

  if (!gatewayModels) {
    return (
      <div className={CARD}>
        <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Models</h2>
        <p className="text-sm text-kumo-subtle">
          Models are managed here only when the deployment provides them through AI Gateway
          (<code className="font-mono text-xs">CF_AI_GATEWAY</code>). Otherwise each user adds
          their own models on their Providers page.
        </p>
      </div>
    )
  }

  const reportFailure = (title: string, err: unknown) => {
    console.error(`${title}:`, err)
    toasts.add({ title, description: rpcFailureDescription(err), variant: 'error' })
  }

  // Every write funnels through here, so writes can't overlap and each is followed by a re-read.
  // Rejects with the write's own failure; a failed re-read is reported here instead, because the
  // write before it went through.
  const write = async (op: () => Promise<void>) => {
    focusBeforeWrite.current = focusedControl()
    setBusy(true)
    try {
      await op()
      await onChanged().catch((err) => reportFailure('Saved, but couldn’t reload the models', err))
    } finally {
      setBusy(false)
    }
  }

  // A write to one model. Its test was of the model as it was, so a write that goes through
  // forgets it, before the re-read and whatever comes of that.
  const writeModel = (model: AdminModel, op: () => Promise<void>) =>
    write(async () => {
      await op()
      modelTests.clearTest(model.id)
    })

  const changeMode = (model: AdminModel, mode: GatewayModelMode) =>
    writeModel(model, () => admin.setGatewayModelMode(model.id, mode))
      .catch((err) => reportFailure(`Couldn’t update ${model.name}`, err))

  // Disabling breaks what runs on the model with nobody there to see it fail, so it is confirmed.
  const requestMode = (model: AdminModel, mode: GatewayModelMode) => {
    if (mode === 'disabled') setPendingDisable(model)
    else void changeMode(model, mode)
  }

  const changeSettings = (model: AdminModel, settings: GatewayModelSettings) =>
    writeModel(model, () => admin.setGatewayModelSettings(model.id, settings))
      .catch((err) => reportFailure(`Couldn’t update ${model.name}`, err))

  // The default is the level of every model that has none of its own, so every test is forgotten.
  const changeDefaultReasoning = (level: ReasoningLevel | null) =>
    write(async () => {
      await admin.setDefaultReasoning(level)
      modelTests.clearTests()
    }).catch((err) => reportFailure(`Couldn’t update “${DEFAULT_REASONING_LABEL}”`, err))

  const changeUserModels = (enabled: boolean) =>
    write(() => admin.setUserModelsEnabled(enabled))
      .catch((err) => reportFailure(`Couldn’t update “${USER_MODELS_LABEL}”`, err))

  const changeModelsDevSuggestions = (enabled: boolean) =>
    write(() => admin.setModelsDevSuggestions(enabled))
      .catch((err) => reportFailure(`Couldn’t update “${MODELS_DEV_LABEL}”`, err))

  const changeProviderEnabled = (provider: AiModelProvider, enabled: boolean) =>
    write(() => admin.setGatewayProviderEnabled(provider, enabled))
      .catch((err) => reportFailure(`Couldn’t update ${PROVIDER_LABELS[provider]}`, err))

  // Runs when the add form's Model ID field is first turned to, and at most once for as long as
  // the panel is mounted: the list is several megabytes, and a failure only costs the suggestions.
  const loadModelsDev = () => {
    if (modelsDevRequest.current) return
    const request = new AbortController()
    modelsDevRequest.current = request
    fetchModelsDev(request.signal).then(
      (list) => setModelsDev({ list }),
      (err) => {
        if (request.signal.aborted) return
        console.error('Failed to load the models.dev list:', err)
        setModelsDev({ list: undefined })
      },
    )
  }

  const confirmRemoval = async () => {
    if (!pendingRemoval) return
    await writeModel(pendingRemoval, () => admin.removeGatewayModel(pendingRemoval.id))
      .catch((err) => reportFailure(`Couldn’t remove ${pendingRemoval.name}`, err))
    setPendingRemoval(null)
  }

  const confirmDisable = async () => {
    if (!pendingDisable) return
    await changeMode(pendingDisable, 'disabled')
    setPendingDisable(null)
  }

  const catalogByProvider = new Map<AiModelProvider, AdminModelView[]>()
  for (const model of gatewayModels.models) {
    if (model.added) continue
    const group = catalogByProvider.get(model.provider)
    if (group) group.push(model)
    else catalogByProvider.set(model.provider, [model])
  }
  const added = gatewayModels.models.filter((model) => model.added)
  const { userModelsEnabled, defaultReasoning } = gatewayModels
  const suggestions = gatewayModels.modelsDevSuggestions
    ? {
        models: suggestModels(
          modelsDev?.list, gatewayModels.providers, gatewayModels.models.map((model) => model.id)),
        // Nothing to suggest even counting the models already here: the request failed, or what
        // it returned is not the list.
        unavailable: modelsDev !== null
          && suggestModels(modelsDev.list, gatewayModels.providers, []).length === 0,
        onEngage: loadModelsDev,
      }
    : undefined

  return (
    <div className={CARD}>
      <h2 className="mb-1 text-lg font-semibold text-kumo-strong">Models</h2>
      <p className="mb-4 text-sm text-kumo-subtle">
        The models this deployment provides through AI Gateway: the catalog this version ships for
        the providers that are on, plus the models this deployment added. A model left on
        its default follows the catalog when the deployment is upgraded.
      </p>

      <SettingSwitch
        label={USER_MODELS_LABEL}
        checked={userModelsEnabled}
        disabled={busy}
        onChange={changeUserModels}
      >
        When on, users can add models under their own IDs on their Providers page, and those run
        through this deployment’s gateway. When off, only the models listed here can be used, and
        the models users already added stop working until this is turned back on. Nothing is
        deleted.
      </SettingSwitch>

      <DefaultReasoningSetting
        level={defaultReasoning}
        disabled={busy}
        onChange={changeDefaultReasoning}
      />

      <section className="mb-6">
        <h3 className={GROUP_HEADING}>Providers</h3>
        {/* A test is not a write: it changes nothing, so it neither takes nor waits for the lock. */}
        <GatewayProviders
          providers={gatewayModels.providerSettings}
          busy={busy}
          onEnabledChange={changeProviderEnabled}
          onTest={(provider) => admin.testGatewayProvider(provider)}
        />
      </section>

      <dl className="mb-3 grid gap-x-3 gap-y-1 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
        {GATEWAY_MODEL_MODES.map((mode) => (
          <div key={mode} className="contents">
            <dt className="font-medium text-kumo-default">{MODES[mode].label}</dt>
            <dd className="text-kumo-subtle">{MODES[mode].meaning}</dd>
          </div>
        ))}
      </dl>
      <p className="mb-6 text-sm text-kumo-subtle">
        Test sends a model one request the way a chat turn would, with the reasoning level in
        effect for it, and shows what came back. A test can use up to 2,048 output tokens.
      </p>

      <div className="flex flex-col gap-6">
        {catalogByProvider.size === 0 && (
          <p className="text-sm text-kumo-subtle">
            This version’s catalog has no models for the providers that are on.
          </p>
        )}

        {[...catalogByProvider].map(([provider, models]) => (
          <section key={provider}>
            <h3 className={GROUP_HEADING}>{PROVIDER_LABELS[provider]}</h3>
            <ul className="flex flex-col gap-2">
              {models.map((model) => (
                <GatewayModelRow
                  key={model.id}
                  model={model}
                  defaultReasoning={defaultReasoning}
                  busy={busy}
                  test={modelTests.tests.get(model.id)}
                  onModeChange={(mode) => requestMode(model, mode)}
                  onSettingsChange={(settings) => changeSettings(model, settings)}
                  onTest={() => modelTests.startTest(model.id)}
                />
              ))}
            </ul>
          </section>
        ))}

        <section>
          <h3 className={GROUP_HEADING}>Added by this deployment</h3>
          {added.length === 0 ? (
            <p className="text-sm text-kumo-subtle">No models added.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {added.map((model) => (
                  <GatewayModelRow
                    key={model.id}
                    model={model}
                    defaultReasoning={defaultReasoning}
                    behavesLikeName={catalogByProvider.get(model.provider)
                      ?.find((listed) => listed.id === model.behavesLike)?.name}
                    busy={busy}
                    test={modelTests.tests.get(model.id)}
                    onModeChange={(mode) => requestMode(model, mode)}
                    onSettingsChange={(settings) => changeSettings(model, settings)}
                    onTest={() => modelTests.startTest(model.id)}
                    onRemove={() => setPendingRemoval(model)}
                  />
                ))}
              </ul>
              <p className="mt-2 text-xs leading-4 text-kumo-subtle">
                To shut a model off, disable it. Removing a model frees its ID instead: gadget
                model bindings made for it{' '}
                {userModelsEnabled
                  ? 'then run, even if the model was disabled.'
                  : 'then stay stopped for as long as users may not add their own models.'}
              </p>
            </>
          )}

          <h4 className="mb-2 mt-5 text-sm font-medium text-kumo-default">Add a model</h4>
          {gatewayModels.providers.length === 0 ? (
            <p className="text-sm text-kumo-subtle">
              No model can be added, because no provider is on. Turn one on under Providers.
            </p>
          ) : (
            <>
              <SettingSwitch
                label={MODELS_DEV_LABEL}
                checked={gatewayModels.modelsDevSuggestions}
                disabled={busy}
                onChange={changeModelsDevSuggestions}
              >
                While you add a model, your browser downloads models.dev’s public model list to
                suggest model IDs, names, limits and what a model can do. A suggestion only fills
                in the form: nothing is added until you select “Add model”.
              </SettingSwitch>
              <AddGatewayModelForm
                providers={gatewayModels.providers}
                behavesLikeOptions={
                  gatewayModels.models.filter((model) => !model.added && model.runtimeKnown)}
                disabled={busy}
                suggestions={suggestions}
                onAdd={(model) => write(() => admin.addGatewayModel(model))}
                onTest={(model) => admin.testNewGatewayModel(model)}
              />
            </>
          )}
        </section>
      </div>

      <DeleteConfirmationDialog
        open={pendingRemoval !== null}
        title={`Remove “${pendingRemoval?.name ?? ''}”?`}
        description={
          <>
            Removing frees the ID <span className="break-all font-mono">{pendingRemoval?.id}</span>
            : gadget model bindings made for the model{' '}
            {userModelsEnabled
              ? 'then run, even if it was disabled'
              : 'then stay stopped for as long as users may not add their own models'}
            , and a model added under the same ID takes its place in the chats that name it. To
            shut a model off, disable it instead.
          </>
        }
        confirmLabel="Remove"
        confirmingLabel="Removing…"
        isDeleting={busy}
        onOpenChange={(open) => { if (!open) setPendingRemoval(null) }}
        onConfirm={() => { void confirmRemoval() }}
      />

      <DeleteConfirmationDialog
        open={pendingDisable !== null}
        title={`Disable “${pendingDisable?.name ?? ''}”?`}
        description={
          <>
            Everything that uses this model stops working until it is enabled or hidden again:
            chats, gadgets that call it, and scheduled tasks. A scheduled task that keeps failing
            is eventually stopped for good, and enabling the model again won’t restart it. To take
            the model out of the pickers without breaking anything, hide it instead.
          </>
        }
        confirmLabel="Disable"
        confirmingLabel="Disabling…"
        isDeleting={busy}
        onOpenChange={(open) => { if (!open) setPendingDisable(null) }}
        onConfirm={() => { void confirmDisable() }}
      />
    </div>
  )
}
