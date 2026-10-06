import { Select, type PortalContainer } from '@cloudflare/kumo'
import { useT } from '../i18n'

import { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { ConnectionConfigField } from './ConnectionConfigField'

export interface AiModelConnectionConfigProps {
  availableModels: AiChatAuthorInfo[]
  selectedModelId: string | undefined
  onSelectedModelIdChange: (id: string | undefined) => void
  selectContainer?: PortalContainer
}

export function AiModelConnectionConfig({
  availableModels,
  selectedModelId,
  onSelectedModelIdChange,
  selectContainer,
}: AiModelConnectionConfigProps) {
  const t = useT()
  return (
    <section className="grid gap-3">
      <ConnectionConfigField
        label={t('gatekeeperModal.model')}
        description={t('gatekeeperModal.chooseModelDesc')}
      >
        <Select
          aria-label={t('gatekeeperModal.selectAiModel')}
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder={t('gatekeeperModal.selectAiModel')}
          value={selectedModelId}
          onValueChange={(v) => onSelectedModelIdChange(v as string | undefined)}
          renderValue={(id) => availableModels.find((m) => m.id === id)?.name ?? id}
        >
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
      </ConnectionConfigField>
    </section>
  )
}
