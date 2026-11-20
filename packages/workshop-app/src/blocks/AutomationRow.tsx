import { useState } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Switch } from '@/components/Switch'
import { Tooltip } from '@/components/Tooltip'
import { AutomationDialog } from './AutomationDialog'
import { AutomationGlyph } from './AutomationGlyph'
import type { AutomationDetails } from './automationDetails'
import { AutomationMoreMenu } from './AutomationMoreMenu'
import { DeleteAutomationDialog } from './DeleteAutomationDialog'
import { LIST_ACTION } from './StarButton'
import { usePending } from './usePending'

export type AutomationRowProps = AutomationDetails

/**
 * One automation in a list of them, on a row of two lines: a clock or a bolt, its name over when
 * it runs (or what it watches) and the workspace it is in where it is listed among others', with
 * why it stopped first where it did; and at the far end how soon it runs next, then its switch,
 * held while the workspace answers, or Off for whoever has no switch, and more, always there,
 * which also deletes it, asking first. The row itself opens all of it (`AutomationDialog`),
 * Delete included.
 */
export const AutomationRow = (automation: AutomationRowProps) => {
  const { kind, title, when, next, note, resource, gadget, workspace, enabled, onEnabledChange, onDelete, problem } = automation
  const [pending, run] = usePending()
  const [open, setOpen] = useState<'details' | 'delete'>()
  const detail = [
    when ?? (kind === 'event' ? resource?.title : undefined) ?? (kind === 'schedule' ? 'Scheduled' : 'When something happens'),
    workspace?.title,
  ].filter(Boolean).join(' · ')
  const shownNote = enabled ? note : undefined

  return (
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <button
        type="button"
        onClick={() => setOpen('details')}
        // The whole row opens it, apart from the controls over it.
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base outline-none after:absolute after:inset-0 after:content-['']"
      >
        <AutomationGlyph kind={kind} enabled={enabled} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className={cn('block truncate font-medium', enabled ? 'text-kumo-default' : 'text-kumo-subtle')}>{title}</span>
          <span className="block truncate text-kumo-subtle">
            {shownNote && <span className={cn(shownNote.tone === 'warning' && 'text-kumo-warning')}>{shownNote.words} · </span>}
            {detail}
          </span>
          {problem && <span role="alert" className="block text-sm text-kumo-danger">{problem}</span>}
        </span>
        {/* Its switch says so, for whoever has one. */}
        {!enabled && !onEnabledChange && <span className="shrink-0 text-kumo-subtle">Off</span>}
        {enabled && next && !shownNote && (
          <Tooltip content={`Next run ${next.at}`} delay={300}>
            {/* On a narrow screen the name has the room, and the dialog says when. */}
            <span className="relative shrink-0 text-kumo-subtle max-md:hidden">
              <span className="sr-only">Next run </span>
              {next.soon}
            </span>
          </Tooltip>
        )}
      </button>
      {onEnabledChange && (
        <span className="relative flex shrink-0 px-1.5">
          <Switch aria-label={`Run ${title}`} checked={enabled} busy={pending} onCheckedChange={(checked) => run(() => onEnabledChange(checked))} />
        </span>
      )}
      <span className="relative flex shrink-0">
        <AutomationMoreMenu
          title={title}
          gadget={gadget}
          workspace={workspace}
          onShowDetails={() => setOpen('details')}
          onDelete={onDelete && (() => setOpen('delete'))}
          triggerClassName={LIST_ACTION}
        />
      </span>
      <AutomationDialog {...automation} open={open === 'details'} onOpenChange={(shown) => setOpen(shown ? 'details' : undefined)} />
      {onDelete && (
        <DeleteAutomationDialog title={title} gadget={gadget} open={open === 'delete'} onOpenChange={(shown) => setOpen(shown ? 'delete' : undefined)} onConfirm={onDelete} />
      )}
    </div>
  )
}
