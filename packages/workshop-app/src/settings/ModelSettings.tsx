import { useState } from 'react'
import { COMPACTION_TRIGGER_RATIO, type AiModelProvider, type ReasoningLevel } from '@gadgets/workshop-shared/api'
import { ModelListItem } from '@/blocks/ModelListItem'
import { SettingPresets } from '@/blocks/SettingPresets'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { Select } from '@/components/Select'
import { TextField } from '@/components/TextField'
import { defaultModelOf } from '@/chat/defaultModel'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ModelDialog } from './ModelDialog'
import type { ModelSave } from './modelForm'
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

/** The context window of one of the deployment's models, which is not the user's to set yet: shown at the model's own, and out of use. */
const SoonContextWindow = ({ known }: { known: number }) => <ContextWindow known={known} tokens={undefined} soon onChange={async () => {}} />

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

/** What every model is told beyond what it comes with. Not there yet, so it is shown and cannot be written. */
const CustomInstructions = () => (
  <SettingsGroup title="Custom instructions" soon plain>
    <SettingsCard field>
      <TextField
        aria-label="Custom instructions"
        rows={4}
        value=""
        placeholder="What the assistant should always know or do, such as “Answer in British English.”"
        onValueChange={() => {}}
        className="rounded-2xl"
      />
    </SettingsCard>
  </SettingsGroup>
)

/** Which of the user's models the model dialog was opened for, and to do what. */
type ModelDialogFor = { kind: 'add' } | { kind: 'edit' | 'duplicate'; id: string }

type OwnModelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: AiModelProvider[]
  gateway: boolean
  onSave: (save: ModelSave) => Promise<boolean>
}

/** The model dialog for changing or copying one of the user's models, which it reads first. Keyed by what it is for. */
const SourcedModelDialog = ({ kind, id, ...props }: OwnModelDialogProps & { kind: 'edit' | 'duplicate'; id: string }) => {
  const { state } = useModelConfig(id)
  const mode = state.status === 'ready'
    ? { kind, source: { profile: state.profile, config: state.config } }
    : { kind, reading: true as const, problem: state.status === 'failed' ? state.message : undefined }
  return <ModelDialog mode={mode} {...props} />
}

/** Which model answers, how it goes about it and what it is always told, and the models there are. */
export const ModelSettings = () => {
  const { state, setPreferred, setQuick, remove, save } = useModelSettings()
  const { problem, attempt } = useAttempt()
  const notice = useConnectionNotice()
  // What the dialog was last opened for, kept while it closes so that it goes as it was.
  const [dialog, setDialog] = useState<ModelDialogFor>({ kind: 'add' })
  const [dialogOpen, setDialogOpen] = useState(false)
  // Each opening, so that a model is read afresh each time, as it may have been changed since.
  const [opens, setOpens] = useState(0)
  // Each change to a model of the user's, after which what is shown of it is read again.
  const [saves, setSaves] = useState(0)
  const openDialog = (next: ModelDialogFor) => {
    setDialog(next)
    setOpens((count) => count + 1)
    setDialogOpen(true)
  }

  if (state.status === 'loading') return <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading models…</p>
  if (state.status === 'failed') {
    return (
      <p className="flex items-center gap-3 px-5 text-base text-kumo-subtle">
        Couldn’t load models: {state.message}
        <Button variant="ghost" onClick={state.retry}>Try again</Button>
      </p>
    )
  }

  const { models, preferred, quick, builtIn, ownAllowed, gateway, providers } = state
  const dialogProps: OwnModelDialogProps = {
    open: dialogOpen,
    onOpenChange: setDialogOpen,
    providers,
    gateway,
    onSave: async (change) => {
      if (notice?.blocked()) return false
      await save(change)
      setSaves((count) => count + 1)
      return true
    },
  }
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
          {answering && <DefaultModelOptions key={`${answering.id}:${saves}`} modelId={answering.id} own={!builtIn.has(answering.id)} />}
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
      <CustomInstructions />
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
                      onEdit={builtIn.has(id) || !ownAllowed ? undefined : () => openDialog({ kind: 'edit', id })}
                      onDuplicate={builtIn.has(id) || !ownAllowed ? undefined : () => openDialog({ kind: 'duplicate', id })}
                      onRemove={builtIn.has(id) ? undefined : () => void attempt(`remove ${name}`, () => remove(id))}
                    />
                  ))}
                </ul>
              )}
        </SettingsCard>
        <SettingsCard>
          {ownAllowed
            ? (
                <SettingRow title="Your own models" description={gateway ? 'Add a model your organization’s providers have that isn’t listed here.' : 'Add a model from a provider you have an API key for.'}>
                  <Button onClick={() => openDialog({ kind: 'add' })}>Add model</Button>
                </SettingRow>
              )
            : <p className="py-4 text-kumo-subtle">Your administrator has turned off adding your own models.</p>}
        </SettingsCard>
      </SettingsGroup>
      {ownAllowed && (dialog.kind === 'add'
        ? <ModelDialog mode={dialog} {...dialogProps} />
        : <SourcedModelDialog key={opens} kind={dialog.kind} id={dialog.id} {...dialogProps} />)}
    </>
  )
}
