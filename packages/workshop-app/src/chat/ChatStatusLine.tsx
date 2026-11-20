import { COMPACTION_TRIGGER_RATIO } from '@gadgets/workshop-shared/api'
import { ComposerStatusLine, type ComposerStatusLineProps } from '@/blocks/ComposerStatusLine'
import { useDevMode } from '@/hooks/useDevMode'
import { modelOptionsOf } from '@/settings/modelOptions'
import { useAttempt } from '@/settings/useAttempt'
import { useModelConfig } from '@/settings/useModelConfig'
import { useModelSettings, type ModelSettingsState } from '@/settings/useModelSettings'
import type { ChatUsage } from './chatUsage'
import { heldWindow, windowSizes } from './contextWindow'

type LineProps = {
  usage: ChatUsage | undefined
  settings: ReturnType<typeof useModelSettings>
  modelId: string
}

const lineOf = (
  { usage, settings, modelId }: LineProps,
  attempt: ReturnType<typeof useAttempt>['attempt'],
  problem: string | undefined,
  sizing: { held: number | undefined; setHeld?: (tokens: number | undefined) => Promise<void> },
): ComposerStatusLineProps => {
  const state: ModelSettingsState = settings.state
  const setHeld = sizing.setHeld
  // The model's own window, from what the Workshop knows of its models, whichever the user's setting is.
  const sizes = setHeld && windowSizes(modelOptionsOf(modelId).contextWindow, sizing.held)
  const measured = usage?.context
  return {
    model: state.status === 'ready'
      ? {
          value: modelId,
          options: state.models.map(({ id, name }) => ({ id, label: name })),
          onChange: (id) => void attempt('change the model', () => settings.setPreferred(id)),
        }
      : undefined,
    context: {
      // The server's figure, against the budget of the model the step ran on, which need not be the one answering next.
      measured: measured && { ...measured, model: (state.status === 'ready' && state.models.find(({ id }) => id === measured.model)?.name) || measured.model },
      compactsAt: COMPACTION_TRIGGER_RATIO,
      cacheRead: usage?.cacheReadTokens,
      cacheWrite: usage?.cacheWriteTokens,
      sizes: sizes && setHeld ? { ...sizes, onChange: (choice) => void attempt('change the context size', () => setHeld(heldWindow(choice))) } : undefined,
    },
    cost: usage?.cost,
    problem,
  }
}

/** The line for a model of the user's own, whose context size is theirs to set. Keyed by the model, as `useModelConfig` asks. */
const OwnModelLine = (props: LineProps) => {
  const { state, setContextWindow } = useModelConfig(props.modelId)
  const { problem, attempt } = useAttempt()
  const ready = state.status === 'ready'
  return <ComposerStatusLine {...lineOf(props, attempt, problem, { held: ready ? state.config.contextWindow : undefined, setHeld: ready ? setContextWindow : undefined })} />
}

const DeploymentModelLine = (props: LineProps) => {
  const { problem, attempt } = useAttempt()
  return <ComposerStatusLine {...lineOf(props, attempt, problem, { held: undefined })} />
}

export type ChatStatusLineProps = {
  usage: ChatUsage | undefined
  /** The model that answers the next message, once it is known. */
  modelId: string | undefined
}

/**
 * Under a chat's composer, in developer mode: the model that answers, changed here for every chat
 * as it is in the settings, and what the chat has used and cost (`ComposerStatusLine`). The user's
 * models are read only while it is shown.
 */
export const ChatStatusLine = ({ usage, modelId }: ChatStatusLineProps) => {
  const devMode = useDevMode()
  const settings = useModelSettings(devMode)
  if (!devMode) return null
  const ready = settings.state.status === 'ready' ? settings.state : undefined
  if (modelId === undefined || !ready) return <ComposerStatusLine cost={usage?.cost} context={{ measured: usage?.context, compactsAt: COMPACTION_TRIGGER_RATIO }} />
  const props = { usage, settings, modelId }
  // A model the deployment provides has a window of its own that is not the user's to set.
  return ready.builtIn.has(modelId) ? <DeploymentModelLine key={modelId} {...props} /> : <OwnModelLine key={modelId} {...props} />
}
