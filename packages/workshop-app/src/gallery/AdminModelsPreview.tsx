import { useState } from 'react'
import type { AdminModelView, AdminSettingsView, GatewayModelTest } from '@gadgets/workshop-shared/api'
import { Button } from '@/components/Button'
import { AdminModelSettings } from '@/settings/admin/AdminModelSettings'
import { AdminCapabilityProvider } from '@/settings/admin/AdminContext'
import { never, PREVIEW_ADMIN_SETTINGS, previewAdmin, previewDelay } from './adminPreview'
import { Section } from './Section'

const MODEL = { added: false, mode: 'enabled', defaultMode: 'enabled', builtInReasoning: 'adaptive', runtimeKnown: true } as const

const MODELS: AdminModelView[] = [
  { ...MODEL, provider: 'anthropic', id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 1_000_000, outputLimit: 128_000, reasoningLevels: ['off', 'low', 'medium', 'high', 'max'], builtInCompactionInputBudget: 200_000, maxCompactionInputBudget: 872_000 },
  { ...MODEL, provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', contextWindow: 200_000, outputLimit: 64_000, reasoningLevels: ['off', 'low', 'medium', 'high'], builtInCompactionInputBudget: 136_000, maxCompactionInputBudget: 136_000, settings: { reasoning: 'high' } },
  { ...MODEL, provider: 'anthropic', id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200_000, reasoningLevels: [], builtInReasoning: null, builtInCompactionInputBudget: 136_000, maxCompactionInputBudget: 136_000, mode: 'hidden' },
  { ...MODEL, provider: 'openai', id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 400_000, outputLimit: 128_000, reasoningLevels: ['minimal', 'low', 'medium', 'high', 'xhigh'], builtInCompactionInputBudget: 200_000, maxCompactionInputBudget: 272_000 },
  { ...MODEL, provider: 'openai', id: 'acme-tuned-with-an-id-long-enough-that-it-has-to-wrap-somewhere', name: 'ACME tuned', added: true, runtimeKnown: false, behavesLike: 'gpt-6-luna', behavesLikeKnown: true, contextWindow: 128_000, capabilities: { imageInput: false, reasoningLevels: ['off'] }, reasoningLevels: ['off'], builtInReasoning: null, builtInCompactionInputBudget: 96_000, maxCompactionInputBudget: 96_000 },
  { ...MODEL, provider: 'cloudflare', id: '@cf/cloudflare/clef', name: 'Clef (Workers AI)', contextWindow: 32_000, reasoningLevels: [], builtInReasoning: null, builtInCompactionInputBudget: 0, maxCompactionInputBudget: 0 },
  { ...MODEL, provider: 'cloudflare-auto-router', id: 'auto', name: 'Auto', contextWindow: 128_000, reasoningLevels: [], builtInReasoning: null, builtInCompactionInputBudget: 96_000, maxCompactionInputBudget: 96_000, settings: { allowedModels: ['openai/*'] } },
]

const GATEWAY: NonNullable<AdminSettingsView['gatewayModels']> = {
  providers: ['anthropic', 'openai', 'cloudflare', 'cloudflare-auto-router'],
  providerSettings: [
    { provider: 'anthropic', enabledBy: 'environment', needsApiToken: false },
    { provider: 'openai', enabledBy: 'admin', needsApiToken: false },
    { provider: 'cloudflare', enabledBy: 'admin', needsApiToken: false },
    { provider: 'cloudflare-auto-router', enabledBy: 'admin', needsApiToken: true },
    { provider: 'google', needsApiToken: false },
  ],
  models: MODELS,
  defaultReasoning: null,
  userModelsEnabled: true,
  modelsDevSuggestions: false,
}

const STATES = {
  ready: 'Through AI Gateway',
  none: 'Not through AI Gateway',
  loading: 'Loading',
  failed: 'Couldn’t load',
} as const
type State = keyof typeof STATES

// What a test finds: OpenAI's answer, and a refusal from everyone else.
const tested = (model: string, openai: boolean): GatewayModelTest =>
  openai ? { model, ok: true } : { model, ok: false, status: 401, message: 'Unauthorized' }

// A fake deployment for one state, which keeps what is changed in it.
const fakeFor = (state: State) => {
  let gateway = GATEWAY
  const change = async (next: (current: typeof gateway) => typeof gateway) => {
    await previewDelay()
    gateway = next(gateway)
  }
  const changeModel = (id: string, next: (model: AdminModelView) => AdminModelView) =>
    change((current) => ({ ...current, models: current.models.map((model) => (model.id === id ? next(model) : model)) }))
  return previewAdmin({
    getSettings: async () => {
      if (state === 'loading') return never()
      await previewDelay()
      if (state === 'failed') throw new Error('The deployment didn’t answer.')
      return { ...PREVIEW_ADMIN_SETTINGS, ...(state === 'ready' && { gatewayModels: gateway }) }
    },
    setUserModelsEnabled: (enabled) => change((current) => ({ ...current, userModelsEnabled: enabled })),
    setModelsDevSuggestions: (enabled) => change((current) => ({ ...current, modelsDevSuggestions: enabled })),
    setDefaultReasoning: (level) => change((current) => ({ ...current, defaultReasoning: level })),
    setGatewayProviderEnabled: (provider, enabled) => change((current) => {
      const providerSettings = current.providerSettings.map((entry) => (entry.provider === provider ? { ...entry, enabledBy: enabled ? 'admin' as const : undefined } : entry))
      return { ...current, providerSettings, providers: providerSettings.filter((entry) => entry.enabledBy).map((entry) => entry.provider) }
    }),
    setGatewayProviderOrder: (order) => change((current) => ({ ...current, providerSettings: order.map((provider) => current.providerSettings.find((entry) => entry.provider === provider)!) })),
    setGatewayModelOrder: (provider, ids) => change((current) => {
      const others = current.models.filter((model) => model.provider !== provider)
      return { ...current, models: [...others, ...ids.map((id) => current.models.find((model) => model.id === id)!)] }
    }),
    setGatewayModelMode: (id, mode) => changeModel(id, (model) => ({ ...model, mode })),
    setGatewayModelSettings: (id, settings) => changeModel(id, (model) => ({ ...model, settings: Object.keys(settings).length > 0 ? settings : undefined })),
    removeGatewayModel: (id) => change((current) => ({ ...current, models: current.models.filter((model) => model.id !== id) })),
    addGatewayModel: async (added) => {
      if (gateway.models.some((model) => model.id === added.id)) {
        await previewDelay()
        throw new Error(`A model with the ID “${added.id}” is already listed.`)
      }
      await change((current) => ({ ...current, models: [...current.models, { ...added, mode: 'enabled', defaultMode: 'enabled', added: true, reasoningLevels: added.capabilities?.reasoningLevels ?? [], builtInReasoning: null, builtInCompactionInputBudget: Math.round(added.contextWindow * 0.7), maxCompactionInputBudget: Math.round(added.contextWindow * 0.7), runtimeKnown: false }] }))
    },
    testGatewayProvider: async (provider) => {
      await previewDelay()
      return tested(`${provider}/a-model`, provider === 'openai')
    },
    testGatewayModel: async (id) => {
      await previewDelay()
      return tested(id, gateway.models.find((model) => model.id === id)?.provider === 'openai')
    },
    testNewGatewayModel: async (model) => {
      await previewDelay()
      return [null, ...(model.capabilities?.reasoningLevels ?? [])].map((reasoning) => ({ ...tested(model.id, model.provider === 'openai'), reasoning }))
    },
  })
}

/** The deployment's Gateway models part, over a fake deployment, in each of its states. */
export const AdminModelsPreview = () => {
  const [state, setState] = useState<State>('ready')
  return (
    <Section title="AdminModelSettings (an admin’s Gateway models part: whether users may add their own and the default reasoning level; the providers, one set by the deployment and one needing a token, each tested (OpenAI answers, the rest are refused) and moved from its more menu; each provider’s models, offered, hidden or disabled (asked first), tested, moved and, from Settings…, given a reasoning level, a compaction budget or, for Auto, the models it may pick; one the deployment added, which can be removed (asked first); adding one, refused for an ID already listed, with models.dev’s suggestions once they are turned on; outside AI Gateway mode; while it loads; and when it could not be read)">
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(STATES).map(([key, label]) => (
            <Button key={key} variant={key === state ? 'primary' : 'secondary'} onClick={() => setState(key as State)}>{label}</Button>
          ))}
        </div>
        <div className="flex w-full max-w-3xl flex-col gap-12 rounded-3xl bg-kumo-base py-6 ring-1 ring-kumo-line">
          {/* A deployment of its own for each state, as the part reads it once. */}
          <AdminCapabilityProvider key={state} admin={fakeFor(state)}>
            <AdminModelSettings />
          </AdminCapabilityProvider>
        </div>
      </div>
    </Section>
  )
}
