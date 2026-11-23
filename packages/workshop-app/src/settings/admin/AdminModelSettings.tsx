import { useEffect, useRef, useState } from 'react'
import { PlusSignIcon } from '@/components/icons'
import { GATEWAY_MODEL_MODES, REASONING_LEVELS, type AdminModelView, type AdminSettingsView, type AiModelProvider, type GatewayModelMode, type GatewayModelSettings, type ReasoningLevel } from '@gadgets/workshop-shared/api'
import { Button, Select, SettingRow, SettingsCard, SettingsGroup, Switch } from '@gadgets/ui'
import { messageOf, useAttempt } from '../useAttempt'
import type { AdminCapability } from './AdminContext'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import { AddGatewayModelDialog, type ModelSuggestions } from './models/AddGatewayModelDialog'
import { GatewayModelRow } from './models/GatewayModelRow'
import { GatewayModelSettingsDialog } from './models/GatewayModelSettingsDialog'
import { GatewayProviderRow } from './models/GatewayProviderRow'
import { ModelConfirmDialog } from './models/ModelConfirmDialog'
import { allowedModelSuggestions, MODES, movedOne, PROVIDER_LABELS, REASONING_LEVEL_LABELS } from './models/modelForm'
import { fetchModelsDev, suggestModels } from './models/modelsDev'
import { useGatewayTests } from './models/useGatewayTests'
import { useAdminSettings } from './useAdminSettings'

type Gateway = NonNullable<AdminSettingsView['gatewayModels']>

// The default level's choice while the deployment sets none.
const BUILT_IN = 'built-in'

// What the user is told of what each way a model is offered does, said once over all of them.
const MODES_SAID = `${GATEWAY_MODEL_MODES.map((mode) => `${MODES[mode].label}: ${MODES[mode].meaning}`).join(' ')} Test sends a model one request the way a chat turn would, with the reasoning level in effect for it, and can use up to 2,048 output tokens.`

type GatewayModelsProps = {
  admin: AdminCapability | null
  gateway: Gateway
  /** Reads the settings again, rejecting where they could not be read. */
  reload: () => Promise<void>
}

/**
 * Every control over the models the deployment provides through AI Gateway. The list is the
 * server's: each change is made, then read again, and one waits for the last, so that what is
 * shown is always what the server holds.
 */
const GatewayModels = ({ admin, gateway, reload }: GatewayModelsProps) => {
  const { problem, attempt } = useAttempt()
  const [stale, setStale] = useState<string>()
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const [adding, setAdding] = useState(false)
  const [settingsOf, setSettingsOf] = useState<string>()
  const [disabling, setDisabling] = useState<AdminModelView>()
  const [removing, setRemoving] = useState<AdminModelView>()
  // The models' tests, by ID, and the providers'. A change to a model forgets its test, and one to
  // the default level forgets them all, as each was of the model as it was.
  const modelTests = useGatewayTests((modelId: string) => admin ? admin.testGatewayModel(modelId) : Promise.reject(new Error('Not connected yet.')))
  const providerTests = useGatewayTests((provider: AiModelProvider) => admin ? admin.testGatewayProvider(provider) : Promise.reject(new Error('Not connected yet.')))
  // What the one request for the models.dev list settled with, `list` undefined where it failed.
  // It is several megabytes, so it is asked for once, and only once a model ID is turned to.
  const [modelsDev, setModelsDev] = useState<{ list: unknown }>()
  const modelsDevRequest = useRef<AbortController>(undefined)
  useEffect(() => () => modelsDevRequest.current?.abort(), [])

  /** Makes one change, then reads the settings again. Resolves to whether it was made; `what` finishes "Couldn’t …". */
  const write = async (what: string, change: (admin: AdminCapability) => Promise<unknown>) => {
    if (writing.current) return false
    writing.current = true
    setBusy(true)
    setStale(undefined)
    try {
      const done = await attempt(what, async () => {
        if (!admin) throw new Error('Not connected yet.')
        await change(admin)
      })
      if (done) await reload().catch((error) => setStale(`Saved, but couldn’t read the models again: ${messageOf(error)}`))
      return done
    } finally {
      writing.current = false
      setBusy(false)
    }
  }

  const writeModel = async (model: AdminModelView, what: string, change: (admin: AdminCapability) => Promise<unknown>) => {
    const done = await write(what, change)
    if (done) modelTests.clearTest(model.id)
    return done
  }

  const setMode = (model: AdminModelView, mode: GatewayModelMode) => writeModel(model, `update ${model.name}`, (server) => server.setGatewayModelMode(model.id, mode))
  const setSettings = (model: AdminModelView, settings: GatewayModelSettings) => writeModel(model, `update ${model.name}`, (server) => server.setGatewayModelSettings(model.id, settings))

  const loadModelsDev = () => {
    if (modelsDevRequest.current) return
    const request = new AbortController()
    modelsDevRequest.current = request
    fetchModelsDev(request.signal).then(
      (list) => setModelsDev({ list }),
      () => {
        if (!request.signal.aborted) setModelsDev({ list: undefined })
      },
    )
  }

  // Each provider's models, the added among them, in the order users see them in.
  const byProvider = new Map<AiModelProvider, AdminModelView[]>()
  for (const model of gateway.models) byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model])
  const added = gateway.models.filter((model) => model.added)
  const { userModelsEnabled, defaultReasoning } = gateway
  const poolSuggestions = allowedModelSuggestions(gateway.providers, gateway.models)
  const suggestions: ModelSuggestions | undefined = gateway.modelsDevSuggestions
    ? {
        models: suggestModels(modelsDev?.list, gateway.providers, gateway.models.map((model) => model.id)),
        // Nothing to suggest even counting the models already here: it failed, or was not the list.
        unavailable: modelsDev !== undefined && suggestModels(modelsDev.list, gateway.providers, []).length === 0,
        onEngage: loadModelsDev,
      }
    : undefined
  const freed = userModelsEnabled ? 'then run, even if it was disabled' : 'then stay stopped for as long as users may not add their own models'
  const providers = gateway.providerSettings.map(({ provider }) => provider)

  return (
    <>
      {(problem ?? stale) && <p role="alert" className="px-5 text-base text-kumo-danger">{problem ?? stale}</p>}
      <SettingsGroup title="AI Gateway">
        <SettingRow
          title="Users may add their own models"
          description="When on, users can add models under their own IDs, which run through this deployment’s gateway. When off, only the models listed here can be used, and those users added stop working until it is turned back on. Nothing is deleted."
        >
          <Switch aria-label="Users may add their own models" checked={userModelsEnabled} busy={busy} onCheckedChange={(enabled) => void write('change whether users may add their own models', (server) => server.setUserModelsEnabled(enabled))} />
        </SettingRow>
        <SettingRow
          title="Default reasoning level"
          description="The level of the agent’s turns on every model listed here that has none of its own. Built-in sets none: each model is asked the way the Workshop asks it by default, which its settings name. A level a model lacks is fitted to the nearest it has. One-shot calls (titles, summaries, gadget model bindings) and the models users added are not affected."
        >
          <Select
            aria-label="Default reasoning level"
            value={defaultReasoning ?? BUILT_IN}
            options={[{ id: BUILT_IN, label: 'Built-in' }, ...REASONING_LEVELS.map((level) => ({ id: level, label: REASONING_LEVEL_LABELS[level] }))]}
            onValueChange={(level) => {
              if (level === (defaultReasoning ?? BUILT_IN)) return
              void write('change the default reasoning level', (server) => server.setDefaultReasoning(level === BUILT_IN ? null : level as ReasoningLevel)).then((done) => done && modelTests.clearTests())
            }}
          />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup
        title="Providers"
        description="Those whose models this deployment can offer through its AI Gateway. Those in CF_AI_GATEWAY_PROVIDERS are always on. Keys and credits are kept in the gateway, out of sight here, so test a provider to find out whether it answers. Model pickers list them in this order, and a new user or chat gets the first enabled model."
      >
        {gateway.providerSettings.map((entry, index) => {
          const move = (by: -1 | 1) => {
            const order = movedOne(providers, index, by)
            return order && (() => void write('reorder the providers', (server) => server.setGatewayProviderOrder(order)))
          }
          return (
            <GatewayProviderRow
              key={entry.provider}
              entry={entry}
              busy={busy}
              test={providerTests.tests.get(entry.provider)}
              onEnabledChange={(enabled) => void write(`change ${PROVIDER_LABELS[entry.provider]}`, (server) => server.setGatewayProviderEnabled(entry.provider, enabled))}
              onMoveUp={move(-1)}
              onMoveDown={move(1)}
              onTest={() => providerTests.startTest(entry.provider)}
            />
          )
        })}
      </SettingsGroup>
      <SettingsGroup title="Catalog" description={MODES_SAID} plain>
        {byProvider.size === 0 && (
          <SettingsCard>
            <p className="py-4 text-kumo-subtle">This version’s catalog has no models for the providers that are on.</p>
          </SettingsCard>
        )}
        {[...byProvider].map(([provider, models]) => (
          <SettingsCard key={provider}>
            <p className="pt-4 text-sm font-medium text-kumo-subtle">{PROVIDER_LABELS[provider]}</p>
            <ul aria-label={`${PROVIDER_LABELS[provider]} models`} className="flex flex-col">
              {models.map((model, index) => {
                const move = (by: -1 | 1) => {
                  const order = movedOne(models.map(({ id }) => id), index, by)
                  return order && (() => void write(`reorder the ${PROVIDER_LABELS[provider]} models`, (server) => server.setGatewayModelOrder(provider, order)))
                }
                return (
                  <GatewayModelRow
                    key={model.id}
                    model={model}
                    behavesLikeName={model.added ? models.find((listed) => !listed.added && listed.id === model.behavesLike)?.name : undefined}
                    test={modelTests.tests.get(model.id)}
                    // Disabling breaks what runs on it with nobody there to see, so it is asked first.
                    onModeChange={(mode) => (mode === 'disabled' ? setDisabling(model) : void setMode(model, mode))}
                    onMoveUp={move(-1)}
                    onMoveDown={move(1)}
                    onTest={() => modelTests.startTest(model.id)}
                    onOpenSettings={() => setSettingsOf(model.id)}
                    onRemove={model.added ? () => setRemoving(model) : undefined}
                  />
                )
              })}
            </ul>
          </SettingsCard>
        ))}
      </SettingsGroup>
      <SettingsGroup
        title="Added by this deployment"
        description={gateway.providers.length === 0
          ? 'No model can be added, as no provider is on. Turn one on under Providers.'
          : added.length === 0
            ? 'No models added yet. Those added are listed under their providers, marked Added.'
            : `Listed under their providers, marked Added. To shut one off, disable it. Removing one frees its ID instead: gadget model bindings made for it ${freed}.`}
        action={<Button icon={PlusSignIcon} disabled={gateway.providers.length === 0} onClick={() => setAdding(true)}>Add model</Button>}
      >
        <SettingRow
          title="Suggest models from models.dev"
          description="While you add a model, your browser downloads models.dev’s public list to suggest IDs, names, limits and what a model can do. A suggestion only fills in the form: nothing is added until you add it."
        >
          <Switch aria-label="Suggest models from models.dev" checked={gateway.modelsDevSuggestions} busy={busy} onCheckedChange={(enabled) => void write('change whether models are suggested from models.dev', (server) => server.setModelsDevSuggestions(enabled))} />
        </SettingRow>
      </SettingsGroup>

      {gateway.providers.length > 0 && (
        <AddGatewayModelDialog
          open={adding}
          onOpenChange={setAdding}
          providers={gateway.providers}
          behavesLikeOptions={gateway.models.filter((model) => !model.added && model.runtimeKnown)}
          suggestions={suggestions}
          onAdd={async (model) => {
            if (!admin) throw new Error('Not connected yet.')
            // Refused, it stays open under why, rather than being said over the part.
            await admin.addGatewayModel(model)
            setAdding(false)
            await reload().catch((error) => setStale(`Added, but couldn’t read the models again: ${messageOf(error)}`))
          }}
          onTest={(model) => admin ? admin.testNewGatewayModel(model) : Promise.reject(new Error('Not connected yet.'))}
        />
      )}
      <GatewayModelSettingsDialog
        model={gateway.models.find((model) => model.id === settingsOf)}
        defaultReasoning={defaultReasoning}
        poolProviders={gateway.providers}
        poolSuggestions={poolSuggestions}
        busy={busy}
        onSettingsChange={async (settings) => {
          const model = gateway.models.find(({ id }) => id === settingsOf)
          return model ? setSettings(model, settings) : false
        }}
        onClose={() => setSettingsOf(undefined)}
      />
      <ModelConfirmDialog
        title={disabling && `Disable “${disabling.name}”?`}
        description="Everything that uses it stops working until it is enabled or hidden again: chats, gadgets that call it, and scheduled tasks. A scheduled task that keeps failing is stopped for good, and enabling the model again won’t restart it. To take it out of the pickers without breaking anything, hide it instead."
        confirmLabel="Disable"
        pendingLabel="Disabling…"
        pending={busy}
        onConfirm={() => disabling && void setMode(disabling, 'disabled').then(() => setDisabling(undefined))}
        onCancel={() => setDisabling(undefined)}
      />
      <ModelConfirmDialog
        title={removing && `Remove “${removing.name}”?`}
        description={removing && <>Removing frees the ID <span className="font-mono wrap-anywhere">{removing.id}</span>: gadget model bindings made for it {freed}, and a model added under the same ID takes its place in the chats that name it. To shut it off, disable it instead.</>}
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={busy}
        onConfirm={() => removing && void writeModel(removing, `remove ${removing.name}`, (server) => server.removeGatewayModel(removing.id)).then(() => setRemoving(undefined))}
        onCancel={() => setRemoving(undefined)}
      />
    </>
  )
}

/**
 * The models the deployment provides through AI Gateway, which is main's admin Models tab: whether
 * users may add their own, the default reasoning level, the providers, each provider's models in
 * the catalog this version ships and those the deployment added, and adding one. Outside AI
 * Gateway mode there is nothing of it here, which it says.
 */
export const AdminModelSettings = () => {
  const { admin, state, reload } = useAdminSettings()
  return (
    <AdminSettingsStatus state={state}>
      {(view) => view.gatewayModels
        ? <GatewayModels admin={admin} gateway={view.gatewayModels} reload={reload} />
        : (
            <SettingsGroup title="AI Gateway">
              <SettingRow
                title="Not through AI Gateway"
                description={<>Models are managed here only while the deployment provides them through AI Gateway (<code className="font-mono">CF_AI_GATEWAY</code>). Otherwise each user adds their own, in their Models settings.</>}
              />
            </SettingsGroup>
          )}
    </AdminSettingsStatus>
  )
}
