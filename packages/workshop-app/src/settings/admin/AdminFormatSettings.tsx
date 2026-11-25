import { useEffect, useState } from 'react'
import { PlusSignIcon } from '@/components/icons'
import type { AdminFormat, AdminFormatPatch, BlueprintPublicInfo, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import { Button, DropdownMenu, SettingRow, SettingsCard, SettingsGroup } from '@gadgets/ui'
import { FormatIcon } from '@/components/FormatIcon'
import { useApi } from '@/rpc/ApiContext'
import { useAttempt } from '../useAttempt'
import { AdminSettingsStatus } from './AdminSettingsStatus'
import { FormatCard } from './formats/FormatCard'
import { movedOrder, offeredOf, promotableOf, type Promotable } from './formats/formatChanges'
import { useAdminSettings } from './useAdminSettings'

/**
 * The blueprints that could be offered as formats: the deployment's featured ones and the admin's
 * own published ones, read once, and nothing where they could not be read.
 */
const useBlueprints = () => {
  const { api, reconnecting } = useApi()
  const [blueprints, setBlueprints] = useState<{ featured: BlueprintPublicInfo[]; own: BlueprintUserSummary[] }>()
  useEffect(() => {
    if (reconnecting) return
    let cancelled = false
    Promise.all([api.listFeaturedBlueprints(), api.listOwnBlueprints()]).then(
      ([featured, own]) => {
        if (!cancelled) setBlueprints({ featured, own })
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])
  return blueprints
}

/** The way to offer another blueprint as a format: a menu of those that could be, each with what it makes. */
const PromoteMenu = ({ candidates, busy, onPromote }: { candidates: Promotable[]; busy: boolean; onPromote: (id: string) => void }) =>
  candidates.length === 0 || busy
    ? <Button icon={PlusSignIcon} disabled>Promote</Button>
    : (
        <DropdownMenu label="Promote" icon={PlusSignIcon} align="end" caret>
          {candidates.map(({ id, title, declared }) => (
            <DropdownMenu.Item key={id} label={title} onSelect={() => onPromote(id)}>
              <FormatIcon name={declared?.icon} className="shrink-0 text-kumo-subtle" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{title || 'Untitled blueprint'}</span>
                <span className="truncate text-sm text-kumo-subtle">{declared ? `Makes ${declared.plural}` : 'Says nothing of what it makes. You’ll name it.'}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu>
      )

/** What people are offered to make, in the order they are offered it, as the buttons they get. */
const Offered = ({ formats }: { formats: AdminFormat[] }) => (
  <SettingRow
    title="What people see"
    description="In the composer’s + menu, the command palette and an empty Library, in this order."
    stacked
  >
    {formats.length === 0
      ? <p className="text-sm text-kumo-subtle">Nothing yet. People are only offered a new workspace.</p>
      : (
          <ul className="flex flex-wrap gap-2">
            {formats.map(({ blueprintId, output }) => (
              <li key={blueprintId} className="flex h-(--control-size) items-center gap-2 rounded-full bg-kumo-base px-(--control-pad) text-sm text-kumo-default ring-1 ring-kumo-line">
                <FormatIcon name={output!.icon} className="size-4 text-kumo-subtle" />
                New {output!.noun}
              </li>
            ))}
          </ul>
        )}
  </SettingRow>
)

/**
 * The deployment's standard formats: blueprints it promotes, which are offered by name wherever
 * something is started ("New Slides") and listed first for the agent. Main's Admin page's Formats
 * tab. Each change is made one at a time and then read back, as the order is the server's to say.
 */
export const AdminFormatSettings = () => {
  const { admin, state, reload, change } = useAdminSettings()
  const blueprints = useBlueprints()
  const { problem, attempt } = useAttempt()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<string>()

  // One change at a time, then what the server holds, so that no two can disagree on the order.
  const mutate = async (what: string, call: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    await attempt(what, async () => {
      await call()
      await reload()
    })
    setBusy(false)
  }

  // Rejects with why, for the field it is typed in to keep what was typed under it.
  const patch = (blueprintId: string) => async (changes: AdminFormatPatch) => {
    if (!admin) throw new Error('Not connected yet.')
    setBusy(true)
    try {
      await admin.updateFormat(blueprintId, changes)
      await reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminSettingsStatus state={state}>
      {({ formats }) => {
        const candidates = blueprints ? promotableOf(blueprints.featured, blueprints.own, formats) : []
        const ids = formats.map(({ blueprintId }) => blueprintId)
        const move = (index: number, delta: number) => {
          const order = movedOrder(ids, index, delta)
          if (!order) return undefined
          return () => void mutate('change the order', () => change(
            (view) => ({ ...view, formats: order.map((id) => view.formats.find(({ blueprintId }) => blueprintId === id)!) }),
            (capability) => capability.setFormatOrder(order),
          ))
        }
        return (
          <>
            {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
            <SettingsGroup
              title="Standard formats"
              description="A promoted blueprint is offered by name, such as “New Slides”, wherever people start something, and the agent is told to prefer it over building the same thing from scratch."
              action={<PromoteMenu candidates={candidates} busy={busy} onPromote={(id) => void mutate('promote the blueprint', () => admin!.promoteFormat(id))} />}
              plain
            >
              <SettingsCard>
                <Offered formats={offeredOf(formats)} />
              </SettingsCard>
              {formats.length === 0
                ? (
                    <SettingsCard>
                      <SettingRow title="No standard formats yet" description="Promote a blueprint to offer it by name wherever people start something, and to have the agent prefer it." />
                    </SettingsCard>
                  )
                : formats.map((format, index) => (
                    <FormatCard
                      key={format.blueprintId}
                      format={format}
                      open={open === format.blueprintId}
                      onToggle={() => setOpen((current) => (current === format.blueprintId ? undefined : format.blueprintId))}
                      busy={busy}
                      onMove={formats.length > 1 ? { up: move(index, -1), down: move(index, 1) } : undefined}
                      onPatch={patch(format.blueprintId)}
                      onSet={(changes) => void mutate('change the format', () => admin!.updateFormat(format.blueprintId, changes))}
                      onRemove={() => void mutate(format.missing ? 'remove the format' : 'stop offering the format', () => admin!.removeFormat(format.blueprintId))}
                    />
                  ))}
            </SettingsGroup>
          </>
        )
      }}
    </AdminSettingsStatus>
  )
}
