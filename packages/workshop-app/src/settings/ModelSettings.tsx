import { useState } from 'react'
import { COMPACTION_TRIGGER_RATIO, type ReasoningLevel } from '@gadgets/workshop-shared/api'
import { ModelListItem } from '@/blocks/ModelListItem'
import { SettingPresets } from '@/blocks/SettingPresets'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { Select } from '@/components/Select'
import { defaultModelOf } from '@/chat/defaultModel'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { contextWindowPresets, modelOptionsOf } from './modelOptions'
import { SoonSelect } from './SoonControls'
import { messageOf, useAttempt } from './useAttempt'
import { useModelConfig } from './useModelConfig'
import { useModelSettings } from './useModelSettings'

// Chosen for no model. No model is called this.
const NONE = '::none'

const REASONING_LABEL: Record<ReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

// When a chat's earlier part is summarised, as shares of its context window, the usual one first.
const COMPACTION_CHOICES = [COMPACTION_TRIGGER_RATIO, 0.7, 0.5].map((ratio) => ({ id: String(ratio), label: ratio === COMPACTION_TRIGGER_RATIO ? `${Math.round(ratio * 100)}% (default)` : `${Math.round(ratio * 100)}%` }))

const TOKENS = new Intl.NumberFormat('en')

/** A number of tokens as the field shows it, with its thousands set apart. */
const formatTyped = (kept: string) => (kept === '' ? '' : TOKENS.format(Number(kept)))

/** A number of tokens as it was typed, with or without its thousands set apart, or nothing for an empty field. Throws for anything else. */
const parseTokens = (typed: string) => {
  const digits = typed.replace(/[\s,._]/g, '')
  if (digits === '') return undefined
  if (!/^[1-9]\d*$/.test(digits)) throw new Error('Enter a whole number of tokens, such as 200,000.')
  return Number(digits)
}

type ContextWindowProps = {
  /** The model's own, where that is known. */
  known: number | undefined
  /** What it is held to, or nothing for its own. */
  tokens: number | undefined
  /** Rejects with why it was not kept. */
  onChange: (tokens: number | undefined) => Promise<void>
  soon?: boolean
}

/** How much of a conversation a model is given at once: its own, one of the usual sizes under it, or a number of the user's. */
const ContextWindow = ({ known, tokens, onChange, soon }: ContextWindowProps) => {
  const notice = useConnectionNotice()
  return (
    <SettingPresets
      title="Context window"
      description="The maximum tokens sent to the model per request. A smaller window costs less."
      soon={soon}
      value={tokens === undefined ? '' : String(tokens)}
      presets={contextWindowPresets(known)}
      customLabel="Context window, in tokens"
      placeholder="Tokens"
      inputMode="numeric"
      format={formatTyped}
      onSave={async (typed) => {
        if (!soon && notice?.blocked()) return { saved: false }
        try {
          await onChange(parseTokens(typed))
          return { saved: true }
        } catch (error) {
          return { saved: false, problem: messageOf(error) }
        }
      }}
    />
  )
}

/** The context window of a model the user added themselves, which is theirs to set. Keyed by the model. */
const OwnContextWindow = ({ modelId, known }: { modelId: string; known: number | undefined }) => {
  const { state, setContextWindow } = useModelConfig(modelId)
  // Nothing to set it by until what it is set to is known, or where that cannot be read.
  if (state.status !== 'ready') return null
  return <ContextWindow known={known} tokens={state.config.contextWindow} onChange={setContextWindow} />
}

/** The context window of one of the deployment's models, which is not the user's to set yet: tried, and not kept. */
const SoonContextWindow = ({ known }: { known: number }) => {
  const [tokens, setTokens] = useState<number>()
  return <ContextWindow known={known} tokens={tokens} soon onChange={async (next) => setTokens(next)} />
}

/**
 * What there is to set of the model that answers, which depends on the model (`modelOptionsOf`):
 * one that does no reasoning has no effort to set, and one nothing is known of has neither that
 * nor a context window. Keyed by the model, so that what is tried for one is not shown for the next.
 */
const DefaultModelOptions = ({ modelId, own }: { modelId: string; own: boolean }) => {
  const { reasoningLevels, contextWindow } = modelOptionsOf(modelId)
  return (
    <>
      {reasoningLevels.length > 0 && (
        <SettingRow title="Reasoning level" description="How much the model thinks before it answers. Higher levels are slower and cost more." soon>
          <SoonSelect
            label="Reasoning level"
            options={[{ id: 'model', label: 'Model default' }, ...reasoningLevels.map((level) => ({ id: level, label: REASONING_LABEL[level] }))]}
          />
        </SettingRow>
      )}
      {own ? <OwnContextWindow modelId={modelId} known={contextWindow} /> : contextWindow !== undefined && <SoonContextWindow known={contextWindow} />}
      {(own || contextWindow !== undefined) && (
        <SettingRow title="Compaction threshold" description="How full the context window gets before earlier messages are compacted into a summary." soon>
          <SoonSelect label="Compaction threshold" options={COMPACTION_CHOICES} />
        </SettingRow>
      )}
    </>
  )
}

/** Which model answers, how it goes about it, and the models there are. */
export const ModelSettings = () => {
  const { state, setPreferred, setQuick, remove } = useModelSettings()
  const { problem, attempt } = useAttempt()

  if (state.status === 'loading') return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading models…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center gap-3 px-5 text-base text-kumo-subtle">
        Couldn’t load models: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }

  const { models, preferred, quick, builtIn } = state
  const options = models.map(({ id, name }) => ({ id, label: name }))
  const answering = defaultModelOf(models, preferred)

  return (
    <>
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      <SettingsGroup title="Defaults" plain>
        <SettingsCard>
          <SettingRow title="Default model" description="Used for new chats. Existing chats keep the model they started with.">
            <Select
              aria-label="Default model"
              value={answering?.id ?? ''}
              options={options}
              placeholder="No models"
              searchable
              onValueChange={(id) => void attempt('change the default model', () => setPreferred(id))}
            />
          </SettingRow>
          {answering && <DefaultModelOptions key={answering.id} modelId={answering.id} own={!builtIn.has(answering.id)} />}
        </SettingsCard>
        <SettingsCard>
          <SettingRow title="Quick model" description="Used for small tasks, such as naming chats. With none, chats stay untitled.">
            <Select
              aria-label="Quick model"
              value={quick ?? NONE}
              options={[{ id: NONE, label: 'None' }, ...options]}
              // One chosen that is no longer offered.
              placeholder={quick ?? 'None'}
              searchable
              onValueChange={(id) => void attempt('change the quick model', () => setQuick(id === NONE ? null : id))}
            />
          </SettingRow>
        </SettingsCard>
      </SettingsGroup>
      <SettingsGroup title="Available models" plain>
        <SettingsCard>
          {models.length === 0
            ? <p className="py-4 text-kumo-subtle">No models yet. This deployment offers none and you haven’t added any.</p>
            : (
                <ul aria-label="Models" className="flex flex-col">
                  {models.map(({ id, name }) => (
                    <ModelListItem
                      key={id}
                      id={id}
                      name={name}
                      builtIn={builtIn.has(id)}
                      roles={[...(id === answering?.id ? ['default' as const] : []), ...(id === quick ? ['quick' as const] : [])]}
                      onRemove={builtIn.has(id) ? undefined : () => void attempt(`remove ${name}`, () => remove(id))}
                    />
                  ))}
                </ul>
              )}
        </SettingsCard>
        <SettingsCard>
          <SettingRow title="Custom models" description="Add a model from a provider you have an API key for." soon>
            <Button>Add model</Button>
          </SettingRow>
          <SettingRow title="AI providers" description="Your API keys for OpenAI, Anthropic, Google and other providers, shared by all of their models." soon>
            <Button>Manage providers</Button>
          </SettingRow>
        </SettingsCard>
      </SettingsGroup>
    </>
  )
}
