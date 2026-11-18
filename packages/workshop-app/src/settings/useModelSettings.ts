import { useEffect, useState } from 'react'
import type { AiChatAuthorInfo, AiModelProvider } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { providerChoices, userModelsAllowed, type ModelSave } from './modelForm'
import { messageOf } from './useAttempt'

export type ModelSettings = {
  /** The language models offered to the user, in the order the server lists them. */
  models: AiChatAuthorInfo[]
  /** The model chosen to answer by default, which may be one no longer offered, or none chosen. */
  preferred: string | null
  /** The model for quick tasks, such as titling a chat, or none: those are then not done. */
  quick: string | null
  /** The ids of the models the deployment provides, which are not the user's to remove. */
  builtIn: ReadonlySet<string>
  /** Whether the user may add models of their own, and change those they did. */
  ownAllowed: boolean
  /** Requests go through the deployment's AI Gateway, with its keys, so the user's models need none. */
  gateway: boolean
  /** The providers a model of the user's can be added under. */
  providers: AiModelProvider[]
}

export type ModelSettingsState =
  | { status: 'loading' }
  | ({ status: 'ready' } & ModelSettings)
  | { status: 'failed'; message: string; retry: () => void }

/**
 * The user's models and which of them are used by default, with the ways to change that. Each
 * change is shown at once and undone if the server refuses, rejecting with why.
 */
export const useModelSettings = () => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<ModelSettingsState>({ status: 'loading' })
  const [attempts, setAttempts] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    Promise.all([api.listModels(), api.getPreferredModel(), api.getQuickModel(), api.getAiConfig()]).then(
      ([models, preferred, quick, config]) => {
        if (cancelled) return
        setState({
          status: 'ready',
          models,
          preferred,
          quick,
          builtIn: new Set(config.enabled ? config.builtInModelIds : []),
          ownAllowed: userModelsAllowed(config),
          gateway: config.enabled,
          providers: providerChoices(config),
        })
      },
      (error) => {
        if (cancelled) return
        // What was listed stays up when it could not be read again.
        setState((current) =>
          current.status === 'ready' ? current : { status: 'failed', message: messageOf(error), retry: () => setAttempts((count) => count + 1) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting, attempts])

  const change = async (shown: Partial<ModelSettings>, undone: (before: ModelSettings) => Partial<ModelSettings>, action: () => Promise<unknown>) => {
    if (state.status !== 'ready') return
    const before = state
    setState((current) => (current.status === 'ready' ? { ...current, ...shown } : current))
    try {
      await action()
    } catch (error) {
      setState((current) => (current.status === 'ready' ? { ...current, ...undone(before) } : current))
      throw error
    }
  }

  return {
    state,
    setPreferred: (id: string) => change({ preferred: id }, ({ preferred }) => ({ preferred }), () => api.setPreferredModel(id)),
    setQuick: (id: string | null) => change({ quick: id }, ({ quick }) => ({ quick }), () => api.setQuickModel(id)),
    /** Removes a model the user added. What named it by default is the server's to sort out, so it is read again. */
    remove: async (id: string) => {
      if (state.status !== 'ready') return
      await change({ models: state.models.filter((model) => model.id !== id) }, ({ models }) => ({ models }), () => api.deleteModel(id))
      setAttempts((count) => count + 1)
    },
    /** Adds, changes or copies a model of the user's, then reads the list again for its name. Rejects with why it was not kept. */
    save: async (save: ModelSave) => {
      if (save.kind === 'update') await api.updateModel(save.profile, save.config)
      // Left out rather than sent as nothing where there is nothing to copy.
      else if (save.copySecretsFrom === undefined) await api.addModel(save.profile, save.config)
      else await api.addModel(save.profile, save.config, save.copySecretsFrom)
      setAttempts((count) => count + 1)
    },
  }
}
