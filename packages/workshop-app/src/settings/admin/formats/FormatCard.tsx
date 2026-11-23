import { Alert02Icon, ArrowDown02Icon, ArrowRight01Icon, ArrowUp02Icon, Delete02Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { OUTPUT_ICONS, type AdminFormat, type AdminFormatPatch, type OutputIcon } from '@gadgets/workshop-shared/api'
import { Button, CardAction, DropdownMenu, LIST_ACTION, type SaveOutcome, SettingField, SettingRow, SettingsCard, Switch, Tag } from '@gadgets/ui'
import { FormatIcon } from '@/components/FormatIcon'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { catalogLine, overrideOf } from './formatChanges'

const ICON_NAMES: Record<OutputIcon, string> = {
  fileText: 'Document',
  gridNine: 'Grid',
  presentation: 'Presentation',
  appWindow: 'App',
  flowArrow: 'Flow',
  kanban: 'Board',
  chartBar: 'Chart',
  table: 'Table',
  notebook: 'Notebook',
  listChecks: 'Checklist',
}

export type FormatCardProps = {
  format: AdminFormat
  /** Its details are showing. */
  open: boolean
  onToggle: () => void
  /** Another change is under way, which this waits for. */
  busy: boolean
  /** Moves it a place up (-1) or down (1), where there is one. */
  onMove?: { up?: () => void; down?: () => void }
  /** Changes it from a field, which keeps what was typed under why where this rejects. */
  onPatch: (patch: AdminFormatPatch) => Promise<void>
  /** Changes it from a switch or a menu, which say nothing of their own of a change refused. */
  onSet: (patch: AdminFormatPatch) => void
  /** Stops offering it, or takes away an entry whose blueprint is gone. */
  onRemove: () => void
}

/**
 * One format on a surface of its own: what it is offered as, with its order and whether it is
 * offered at its end, opening to how it is presented and how the agent picks it, and the way to
 * stop offering it. A field left empty follows what the blueprint says (`overrideOf`). One whose
 * blueprint was deleted says so, and offers only to be taken away.
 */
export const FormatCard = ({ format, open, onToggle, busy, onMove, onPatch, onSet, onRemove }: FormatCardProps) => {
  const notice = useConnectionNotice()
  const needsNaming = !format.missing && !format.output
  // From what is filled in so far where the presentation is not whole yet: `output` is all or nothing.
  const icon = format.output?.icon ?? format.overrides?.icon
  const noun = format.output?.noun ?? format.overrides?.noun ?? ''
  const plural = format.output?.plural ?? format.overrides?.plural ?? ''

  const save = async (patch: AdminFormatPatch): Promise<SaveOutcome> => {
    if (notice?.blocked()) return { saved: false }
    try {
      await onPatch(patch)
      return { saved: true }
    } catch (error) {
      return { saved: false, problem: error instanceof Error ? error.message : String(error) }
    }
  }

  return (
    <SettingsCard>
      <div className="group flex items-center gap-3 py-3">
        <button type="button" aria-expanded={open} onClick={onToggle} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left">
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl bg-kumo-base ring-1 ring-kumo-line', format.missing ? 'text-kumo-danger' : 'text-kumo-subtle')}>
            {format.missing ? <Alert02Icon aria-hidden="true" className="size-5" /> : <FormatIcon name={icon} className="size-5" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-medium text-kumo-default">
              <span className="min-w-0 truncate">{format.output ? `New ${format.output.noun}` : format.blueprintTitle || format.blueprintId}</span>
              {format.bundled && <Tag>Bundled</Tag>}
              {!format.enabled && !format.missing && <Tag>Off</Tag>}
              {needsNaming && <Tag>Needs a name</Tag>}
            </span>
            <span className={cn('truncate text-sm', format.missing ? 'text-kumo-danger' : 'text-kumo-subtle')}>
              {format.missing
                ? 'Its blueprint was deleted'
                : needsNaming
                  ? 'Give it a name to offer it'
                  : `${format.blueprintTitle} · under ${format.output!.plural} in the Library`}
            </span>
          </span>
          <ArrowRight01Icon aria-hidden="true" weight="bold" className={cn('size-3 shrink-0 text-kumo-subtle transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        </button>
        {onMove && (
          <CardAction shown={open}>
            <Button variant="ghost" icon={ArrowUp02Icon} aria-label={`Move ${format.blueprintTitle} up`} disabled={busy || !onMove.up} onClick={onMove.up} className={LIST_ACTION} />
            <Button variant="ghost" icon={ArrowDown02Icon} aria-label={`Move ${format.blueprintTitle} down`} disabled={busy || !onMove.down} onClick={onMove.down} className={LIST_ACTION} />
          </CardAction>
        )}
        <Switch aria-label={`Offer ${format.blueprintTitle}`} checked={format.enabled} disabled={format.missing} busy={busy} onCheckedChange={(enabled) => onSet({ enabled })} />
      </div>
      {open && (format.missing
        ? (
            <SettingRow title="Remove it" description="The blueprint behind it was deleted, so nobody is offered it.">
              <Button icon={Delete02Icon} disabled={busy} onClick={onRemove}>Remove</Button>
            </SettingRow>
          )
        : (
            <>
              <SettingRow
                title="Icon"
                description="It draws the format’s outputs in the Library too."
              >
                <DropdownMenu
                  icon={<FormatIcon name={icon} />}
                  aria-label={`Icon: ${icon ? ICON_NAMES[icon] : 'none'}`}
                  align="end"
                  inPlace
                >
                  <DropdownMenu.SwatchGroup
                    aria-label="Icon"
                    value={icon ?? ''}
                    onValueChange={(next) => onSet({ overrides: { icon: overrideOf(next as OutputIcon, format.declared?.icon) } })}
                  >
                    {OUTPUT_ICONS.map((name) => (
                      <DropdownMenu.Swatch key={name} value={name} label={ICON_NAMES[name]}>
                        <FormatIcon name={name} className="size-5" />
                      </DropdownMenu.Swatch>
                    ))}
                  </DropdownMenu.SwatchGroup>
                </DropdownMenu>
              </SettingRow>
              <SettingField
                title="Name"
                description={format.declared ? `Offered as “New ${noun || format.declared.noun}”. Left empty, it is the blueprint’s own, “${format.declared.noun}”.` : 'What it is offered as: “New …”.'}
                value={noun}
                optional
                placeholder={format.declared?.noun ?? 'Document'}
                onSave={(typed) => save({ overrides: { noun: overrideOf(typed, format.declared?.noun) } })}
              />
              <SettingField
                title="Plural"
                description={format.declared ? `What its outputs are listed under. Left empty, “${format.declared.plural}”.` : 'What its outputs are listed under in the Library.'}
                value={plural}
                optional
                placeholder={format.declared?.plural ?? 'Documents'}
                onSave={(typed) => save({ overrides: { plural: overrideOf(typed, format.declared?.plural) } })}
              />
              <SettingField
                title="Hint for the agent"
                description="Only if the agent needs to know when to prefer this format over another. Its blueprint’s description does most of the work."
                value={format.agentHint}
                optional
                placeholder="Prefer for customer-facing decks"
                onSave={(typed) => save({ agentHint: typed })}
              />
              {format.output && (
                <SettingRow
                  title="What the agent reads"
                  description={`Standard formats are listed first in the agent’s catalog, as this. Applies to outputs made from now on.${format.bundled ? ' A bundled blueprint can change its own names as the deployment updates; what is typed here stays.' : ''}`}
                  stacked
                >
                  <p className="flex w-full flex-col gap-1 rounded-2xl bg-kumo-base px-3 py-2 font-mono text-xs/4 text-kumo-subtle ring-1 ring-kumo-line">
                    <span className="text-kumo-default">{catalogLine(format.output.noun, format.agentHint)}</span>
                    {format.blueprintDescription && <span>{format.blueprintDescription}</span>}
                  </p>
                </SettingRow>
              )}
              <SettingRow
                title={format.bundled ? 'Ships with the deployment' : 'Stop offering'}
                description={`${format.enabled ? 'Switched off, it is offered to nobody and left out of the agent’s catalog. What was made from it keeps working.' : 'Offered to nobody, and left out of the agent’s catalog.'}${format.bundled ? ' It stays in this list either way, with its name, hint and place.' : ''}`}
              >
                {!format.bundled && <Button icon={Delete02Icon} disabled={busy} onClick={onRemove}>Stop offering</Button>}
              </SettingRow>
            </>
          ))}
    </SettingsCard>
  )
}
