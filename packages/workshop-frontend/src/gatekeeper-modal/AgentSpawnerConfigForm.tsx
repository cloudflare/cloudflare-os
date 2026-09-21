import { Checkbox, Select, type PortalContainer } from '@cloudflare/kumo'
import { AiChatAuthorInfo, WorkpieceId, validateBindingName } from '@gadgets/workshop-shared/api'
import { WorkshopInput } from '../components/WorkshopControls'
import { ConnectionConfigField } from './ConnectionConfigField'

/**
 * One prospective entry of AgentSpawnerConfig.env: a workpiece the spawned agents may use, and
 * the name they see it under. Candidates are prefilled from the gadget the spawner is being
 * created for (its own bindings, plus the gadget itself); the user toggles them on or off and may
 * rename them. Choosing targets the gadget doesn't already hold isn't supported here yet.
 */
export interface SpawnerEnvRow {
  /** The workpiece the entry points at. */
  target: WorkpieceId

  /** Display name of the target, e.g. the connected resource's title. */
  targetTitle: string

  /** Name the spawned agents will see the target under (`env.NAME`). */
  name: string

  /** Whether the entry is included in the spawner's env at all. */
  enabled: boolean
}

/**
 * Returns a human-readable complaint about the env rows, or null if they're acceptable. Only
 * enabled rows matter: a disabled row is simply not part of the env.
 */
export function validateSpawnerEnv(rows: SpawnerEnvRow[]): string | null {
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.enabled) continue
    try {
      validateBindingName(row.name)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (seen.has(row.name)) {
      return `Two bindings are both named "${row.name}".`
    }
    seen.add(row.name)
  }
  return null
}

/** Converts the rows into the AgentSpawnerConfig.env map. Assumes validateSpawnerEnv() passed. */
export function spawnerEnvFromRows(rows: SpawnerEnvRow[]): Record<string, WorkpieceId> {
  const env: Record<string, WorkpieceId> = {}
  for (const row of rows) {
    if (row.enabled) env[row.name] = row.target
  }
  return env
}

export interface AgentSpawnerConfigFormProps {
  availableModels: AiChatAuthorInfo[]
  displayName: string
  modelId: string | null
  env: SpawnerEnvRow[]
  envError: string | null
  onDisplayNameChange: (value: string) => void
  onModelIdChange: (id: string | null) => void
  onEnvChange: (env: SpawnerEnvRow[]) => void
  selectContainer?: PortalContainer
}

export function AgentSpawnerConfigForm({
  availableModels,
  displayName,
  modelId,
  env,
  envError,
  onDisplayNameChange,
  onModelIdChange,
  onEnvChange,
  selectContainer,
}: AgentSpawnerConfigFormProps) {
  const updateRow = (index: number, updates: Partial<SpawnerEnvRow>) => {
    onEnvChange(env.map((row, i) => (i === index ? { ...row, ...updates } : row)))
  }

  return (
    <section className="grid gap-4">
      <ConnectionConfigField
        label="Display name"
        description="Name this agent capability for this connection."
      >
        <WorkshopInput
          aria-label="Agent display name"
          placeholder="e.g. Email Responder"
          value={displayName}
          onChange={(e) => onDisplayNameChange(e.target.value)}
          className="w-full"
        />
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Model"
        description="Choose the model spawned agents will use."
      >
        <Select
          aria-label="Agent model"
          className="w-full text-sm [&_button]:!h-9"
          container={selectContainer}
          placeholder="Select a model"
          value={modelId}
          onValueChange={(v) => onModelIdChange(v as string | null)}
          renderValue={(id) => {
            if (id === null) return 'None (no agent)'
            return availableModels.find((m) => m.id === id)?.name ?? String(id)
          }}
        >
          <Select.Option value={null as any}>
            None (no agent)
          </Select.Option>
          {availableModels.map(model => (
            <Select.Option key={model.id} value={model.id}>
              {model.name}
            </Select.Option>
          ))}
        </Select>
        <p className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
          Choose "None" to create conversations without an agent.
        </p>
      </ConnectionConfigField>

      <ConnectionConfigField
        label="Agent bindings"
        description="What spawned agents may use, and the names they see it under."
      >
        {env.length === 0 ? (
          <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
            Nothing is available to offer spawned agents here. Create the agent from a gadget's
            Connections tab to give it access to that gadget and its resources.
          </p>
        ) : (
          <div className="grid gap-2">
            {env.map((row, index) => (
              <div key={`${row.target}:${index}`} className="flex items-center gap-2">
                <Checkbox
                  aria-label={`Give spawned agents access to ${row.targetTitle}`}
                  checked={row.enabled}
                  onCheckedChange={(checked) => updateRow(index, { enabled: checked === true })}
                />
                <WorkshopInput
                  aria-label={`Binding name for ${row.targetTitle}`}
                  value={row.name}
                  disabled={!row.enabled}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  className="!h-8 w-[180px] min-w-0 font-mono"
                />
                <span className="min-w-0 flex-1 truncate text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                  {row.targetTitle}
                </span>
              </div>
            ))}
            {envError && (
              <p className="text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-danger">
                {envError}
              </p>
            )}
          </div>
        )}
      </ConnectionConfigField>
    </section>
  )
}
