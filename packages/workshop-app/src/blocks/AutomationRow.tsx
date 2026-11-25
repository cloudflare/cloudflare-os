import { useState } from 'react'
import { SecurityCheckIcon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { LIST_ACTION, Switch } from '@gadgets/ui'
import { AutomationDialog } from './AutomationDialog'
import { AutomationGlyph } from './AutomationGlyph'
import type { AutomationDetails } from './automationDetails'
import { AutomationMoreMenu } from './AutomationMoreMenu'
import { DeleteAutomationDialog } from './DeleteAutomationDialog'
import { StatusPill } from './StatusPill'
import { usePending } from './usePending'

export type AutomationRowProps = AutomationDetails & {
  /**
   * What it asked that waits on someone, outside any chat: how many, as its pill says it ("Needs
   * approval"), and the first of them, as its second line. Decided in its app.
   */
  waiting?: { words: string; count?: number; first: string }
}

/**
 * One automation in a list of them, on a row of two lines: a bolt, its name over what it watches
 * and the workspace it is in where it is listed among others'; and at the far end its switch,
 * held while the workspace answers, or Off for whoever has no switch, and more, always there,
 * which also deletes it, asking first. What it asked that waits on someone is its second line,
 * with a pill. The row itself opens all of it (`AutomationDialog`), Delete included.
 */
export const AutomationRow = ({ waiting, ...automation }: AutomationRowProps) => {
  const { title, resource, gadget, workspace, enabled, onEnabledChange, onDelete, problem } = automation
  const [pending, run] = usePending()
  const [open, setOpen] = useState<'details' | 'delete'>()
  const detail = waiting ? waiting.first : [resource?.title, workspace?.title].filter(Boolean).join(' · ')

  return (
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <button
        type="button"
        onClick={() => setOpen('details')}
        // The whole row opens it, apart from the controls over it.
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base outline-none after:absolute after:inset-0 after:content-['']"
      >
        <AutomationGlyph enabled={enabled} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className={cn('block truncate font-medium', enabled ? 'text-kumo-default' : 'text-kumo-subtle')}>{title}</span>
          {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
          {problem && <span role="alert" className="block text-sm text-kumo-danger">{problem}</span>}
        </span>
        {/* Its switch says so, for whoever has one. */}
        {!enabled && !onEnabledChange && <span className="shrink-0 text-kumo-subtle">Off</span>}
        {waiting && <StatusPill words={waiting.words} tone="warning" icon={SecurityCheckIcon} count={waiting.count} />}
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
