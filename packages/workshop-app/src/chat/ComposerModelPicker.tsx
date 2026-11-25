import { Select } from '@gadgets/ui'
import { useDevMode } from '@/hooks/useDevMode'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf } from '@/settings/useAttempt'
import { useModelSettings } from '@/settings/useModelSettings'

export type ComposerModelPickerProps = {
  /** The model that answers the next message, once it is known. */
  modelId: string | undefined
  /** Says why the model could not be changed, for the composer to show. */
  onProblem: (message: string) => void
}

/**
 * In developer mode, before a composer's send button: the model that answers, changed here for
 * every chat as it is in the settings (`setPreferred`, which tells `useDefaultModel`). Nothing
 * otherwise, nor until the user's models are read, which is only while it is on.
 */
export const ComposerModelPicker = ({ modelId, onProblem }: ComposerModelPickerProps) => {
  const devMode = useDevMode()
  const settings = useModelSettings(devMode)
  const connection = useConnectionNotice()
  if (!devMode || modelId === undefined || settings.state.status !== 'ready' || settings.state.models.length === 0) return null
  const { models } = settings.state
  return (
    // A long name is cut short here, so that it leaves the message room on its line.
    <span className="flex max-w-40 min-w-0 max-sm:max-w-28">
      <Select
        aria-label="Model"
        value={modelId}
        options={models.map(({ id, name }) => ({ id, label: name }))}
        onValueChange={(id) => {
          if (connection?.blocked()) return
          settings.setPreferred(id).catch((error: unknown) => onProblem(`Couldn’t change the model: ${messageOf(error)}`))
        }}
        searchable={models.length > 8}
        compact={{ align: 'end', medium: true }}
      />
    </span>
  )
}
