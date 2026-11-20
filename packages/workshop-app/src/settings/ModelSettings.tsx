import { useState } from 'react'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { ModelListItem } from '@/blocks/ModelListItem'
import { SettingPresets } from '@/blocks/SettingPresets'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { defaultModelOf } from '@/chat/defaultModel'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ModelDialog } from './ModelDialog'
import type { ModelSave } from './modelForm'
import { modelChoiceSettings } from './modelChoiceSettings'
import { contextWindowPresets, modelOptionsOf } from './modelOptions'
import { SettingDefinitionRow } from './SettingDefinitionRow'
import { messageOf, useAttempt } from './useAttempt'
import { useModelConfig } from './useModelConfig'
import { useModelSettings } from './useModelSettings'

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
}

/** How much of a conversation a model is given at once: its own, one of the usual sizes under it, or a number of the user's. */
const ContextWindow = ({ known, tokens, onChange }: ContextWindowProps) => {
  const notice = useConnectionNotice()
  return (
    <SettingPresets
      title="Context window"
      description="The maximum tokens sent to the model per request. A smaller window costs less."
      value={tokens === undefined ? '' : String(tokens)}
      presets={contextWindowPresets(known)}
      customLabel="Context window, in tokens"
      placeholder="Tokens"
      inputMode="numeric"
      format={formatTyped}
      onSave={async (typed) => {
        if (notice?.blocked()) return { saved: false }
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

/** Which model answers, and the models there are. */
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
  const answering = defaultModelOf(models, preferred)
  const { defaultModel, quickModel } = modelChoiceSettings(state, { setPreferred, setQuick })

  return (
    <>
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      <SettingsGroup title="Defaults">
        <SettingDefinitionRow setting={defaultModel} attempt={attempt} />
        {/* Under the model it is of. The deployment's models keep their own; the user's are theirs to set. Keyed by the model, so that what is tried for one is not shown for the next. */}
        {answering && !builtIn.has(answering.id) && <OwnContextWindow key={`${answering.id}:${saves}`} modelId={answering.id} known={modelOptionsOf(answering.id).contextWindow} />}
        <SettingDefinitionRow setting={quickModel} attempt={attempt} />
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
