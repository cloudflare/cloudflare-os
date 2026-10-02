// Admin panel for the models a deployment provides through AI Gateway.
//
// The list is the server's: every write is followed by a re-read, and each control shows what the
// server reported rather than what was just chosen.

import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Switch, useKumoToastManager } from '@cloudflare/kumo'
import { GATEWAY_MODEL_MODES } from '@gadgets/workshop-shared/api'
import type {
  AdminApi,
  AdminModel,
  AdminSettingsView,
  AiModelProvider,
  GatewayModelMode,
} from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import DeleteConfirmationDialog from '../../components/DeleteConfirmationDialog'
import { AddGatewayModelForm } from './AddGatewayModelForm'
import { GatewayModelRow, MODES } from './GatewayModelRow'
import { rpcFailureDescription } from '../../rpcErrors'
import { PROVIDER_LABELS } from './modelForm'
import { fetchModelsDev, suggestModels } from './modelsDev'

const CARD = 'rounded-xl border border-kumo-line bg-kumo-elevated p-6'
const GROUP_HEADING = 'mb-2 text-sm font-semibold text-kumo-default'
const USER_MODELS_LABEL = 'Users may add their own models'
const MODELS_DEV_LABEL = 'Suggest models from models.dev'

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
    <div className="mb-4 flex items-center gap-4 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium text-kumo-default">{label}</p>
        <p id={help} className="mt-0.5 text-kumo-subtle">{children}</p>
      </div>
      <Switch
        aria-label={label}
        aria-describedby={help}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
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
  // What this panel's one request for the models.dev list settled with: the list, or undefined
  // when the request failed. Null until then.
  const [modelsDev, setModelsDev] = useState<{ list: unknown } | null>(null)
  const modelsDevRequest = useRef<AbortController | null>(null)
  useEffect(() => () => modelsDevRequest.current?.abort(), [])

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
    setBusy(true)
    try {
      await op()
      await onChanged().catch((err) => reportFailure('Saved, but couldn’t reload the models', err))
    } finally {
      setBusy(false)
    }
  }

  const changeMode = (model: AdminModel, mode: GatewayModelMode) =>
    write(() => admin.setGatewayModelMode(model.id, mode))
      .catch((err) => reportFailure(`Couldn’t update ${model.name}`, err))

  const changeUserModels = (enabled: boolean) =>
    write(() => admin.setUserModelsEnabled(enabled))
      .catch((err) => reportFailure(`Couldn’t update “${USER_MODELS_LABEL}”`, err))

  const changeModelsDevSuggestions = (enabled: boolean) =>
    write(() => admin.setModelsDevSuggestions(enabled))
      .catch((err) => reportFailure(`Couldn’t update “${MODELS_DEV_LABEL}”`, err))

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
    await write(() => admin.removeGatewayModel(pendingRemoval.id))
      .catch((err) => reportFailure(`Couldn’t remove ${pendingRemoval.name}`, err))
    setPendingRemoval(null)
  }

  const catalogByProvider = new Map<AiModelProvider, AdminModel[]>()
  for (const model of gatewayModels.models) {
    if (model.added) continue
    const group = catalogByProvider.get(model.provider)
    if (group) group.push(model)
    else catalogByProvider.set(model.provider, [model])
  }
  const added = gatewayModels.models.filter((model) => model.added)
  const { userModelsEnabled } = gatewayModels
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
        the providers the gateway enables, plus the models this deployment added. A model left on
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

      <dl className="mb-6 grid gap-x-3 gap-y-1 rounded-lg border border-kumo-line bg-kumo-base px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
        {GATEWAY_MODEL_MODES.map((mode) => (
          <div key={mode} className="contents">
            <dt className="font-medium text-kumo-default">{MODES[mode].label}</dt>
            <dd className="text-kumo-subtle">{MODES[mode].meaning}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-col gap-6">
        {catalogByProvider.size === 0 && (
          <p className="text-sm text-kumo-subtle">
            This version’s catalog has no models for the providers the gateway enables.
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
                  busy={busy}
                  onModeChange={(mode) => changeMode(model, mode)}
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
                    busy={busy}
                    onModeChange={(mode) => changeMode(model, mode)}
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
              No model can be added, because the gateway enables no provider it can serve one
              through (<code className="font-mono text-xs">CF_AI_GATEWAY_PROVIDERS</code>).
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
                suggest model IDs, names and limits. A suggestion only fills in the form: nothing
                is added until you select “Add model”.
              </SettingSwitch>
              <AddGatewayModelForm
                providers={gatewayModels.providers}
                disabled={busy}
                suggestions={suggestions}
                onAdd={(model) => write(() => admin.addGatewayModel(model))}
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
    </div>
  )
}
