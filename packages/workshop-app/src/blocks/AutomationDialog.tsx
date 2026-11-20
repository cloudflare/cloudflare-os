import { useState, type ReactNode } from 'react'
import { ArrowRightIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { Dialog } from '@/components/Dialog'
import { LinkButton } from '@/components/LinkButton'
import { Markdown } from '@/components/Markdown'
import { Switch } from '@/components/Switch'
import { AutomationGlyph } from './AutomationGlyph'
import { deletionProblem, deletionWords, type AutomationDetails } from './automationDetails'
import { ResourceLink } from './ResourceLink'
import { usePending, type ActionResult } from './usePending'

export type AutomationDialogProps = AutomationDetails & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const LINK = 'inline-flex max-w-full min-w-0 items-center gap-1.5 text-kumo-default underline-offset-2 hover:underline [&>svg]:shrink-0'

// One thing known of it: what it is, then what it says.
const Fact = ({ label, children }: { label: string; children: ReactNode }) => (
  <li className="flex shrink-0 items-center gap-4 border-t border-kumo-line py-3.5 first:border-t-0">
    <span className="w-24 shrink-0 text-sm text-kumo-subtle">{label}</span>
    <span className="min-w-0 flex-1 leading-snug text-kumo-default">{children}</span>
  </li>
)

// What the dialog holds, which is only there while it is open: why the last try failed starts over each time.
const AutomationDialogContent = ({ kind, title, when, next, note, description, resource, gadget, workspace, enabled, onEnabledChange, onDelete, problem, pending, onAsk, onClose }: AutomationDetails & {
  pending: boolean
  onAsk: (action: () => ActionResult) => void
  onClose: () => void
}) => {
  const [switching, runSwitch] = usePending()
  const [deleteProblem, setDeleteProblem] = useState<string>()
  // Leaves the dialog for where it goes, which may be beside the page, under where it was.
  const go = (open: () => void) => () => {
    onClose()
    open()
  }
  const remove = onDelete && (() => {
    setDeleteProblem(undefined)
    onAsk(async () => {
      try {
        await onDelete()
      } catch (error) {
        setDeleteProblem(deletionProblem(error))
      }
    })
  })
  const kindWords = kind === 'schedule' ? 'Scheduled' : 'When something happens'

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-5">
        <AutomationGlyph kind={kind} enabled={enabled} />
        <div className="flex min-h-10 min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{title}</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">{enabled ? kindWords : `${kindWords} · Off`}</Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" disabled={pending} className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pb-1">
        {description && <div className="leading-normal text-kumo-default"><Markdown>{description}</Markdown></div>}
        <ul aria-label="Details" className="flex flex-col rounded-(--surface-radius) bg-kumo-tint px-5 py-1">
          {when && <Fact label="Runs">{when}</Fact>}
          {kind === 'event' && <Fact label="Watches">{resource ? <ResourceLink {...resource} /> : 'Something a connected service sends'}</Fact>}
          {kind === 'schedule' && (
            <Fact label="Next run">
              {!enabled
                ? <span className="text-kumo-subtle">Not while it’s off</span>
                : note
                  ? <span className={cn(note.tone === 'warning' && 'text-kumo-warning')}>{note.words}</span>
                  : next ? next.at.charAt(0).toUpperCase() + next.at.slice(1) : <span className="text-kumo-subtle">Not known yet</span>}
            </Fact>
          )}
          {kind === 'event' && enabled && note && <Fact label="Status"><span className={cn(note.tone === 'warning' && 'text-kumo-warning')}>{note.words}</span></Fact>}
          {gadget && (
            <Fact label="Runs app">
              <LinkButton href={gadget.href} onClick={go(gadget.onOpen)} className={LINK}>
                <span className="truncate">{gadget.title}</span>
                <ArrowRightIcon aria-hidden="true" className="size-3.5 text-kumo-subtle" weight="bold" />
              </LinkButton>
            </Fact>
          )}
          {workspace && (
            <Fact label="Workspace">
              <LinkButton href={workspace.href} onClick={go(workspace.onOpen)} className={LINK}>
                {workspace.icon}
                <span className="truncate">{workspace.title}</span>
              </LinkButton>
            </Fact>
          )}
        </ul>
        {/* An outline rather than a surface, as it is one setting, not a list. */}
        <div className="flex items-center gap-4 rounded-(--surface-radius) py-3.5 ps-5 pe-4 leading-snug ring-1 ring-kumo-line ring-inset">
          <p className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium text-kumo-default">{enabled ? 'On' : 'Off'}</span>
            <span className="text-sm text-kumo-subtle">
              {onEnabledChange
                ? (enabled ? 'Runs by itself. Turn it off to stop it without losing it.' : 'Kept as it was set up, but not running.')
                : 'Only those who build in its workspace can change this.'}
            </span>
          </p>
          {onEnabledChange && (
            <Switch aria-label={`Run ${title}`} checked={enabled} busy={switching} disabled={pending} onCheckedChange={(checked) => runSwitch(() => onEnabledChange(checked))} />
          )}
        </div>
      </div>

      <footer className="flex flex-col gap-3 p-6">
        {(deleteProblem ?? problem) && <Banner title={deleteProblem ?? problem!} />}
        <div className="flex items-center gap-2">
          {remove && (
            <ConfirmMenu
              label={pending ? 'Deleting…' : 'Delete'}
              title={`Delete “${title}”?`}
              description={deletionWords({ gadget })}
              confirmLabel="Delete"
              onConfirm={remove}
              disabled={pending}
              align="start"
            />
          )}
          <Dialog.Close render={(props) => <Button {...props} variant="primary" disabled={pending} className="ms-auto">Done</Button>} />
        </div>
      </footer>
    </>
  )
}

/**
 * One automation, opened from its row: what it does, when it runs and when next (or why it
 * stopped), what it watches, the app it runs and the workspace it is in, each of which goes there,
 * then its switch, and at its foot Delete, which asks first. Once deleted, whoever shows it takes
 * it away with its row; a failure stays in it, under why.
 */
export const AutomationDialog = ({ open, onOpenChange, ...automation }: AutomationDialogProps) => {
  const [pending, run] = usePending()
  return (
    // Not put away while it is being deleted.
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
      <AutomationDialogContent {...automation} pending={pending} onAsk={(action) => { if (!pending) run(action) }} onClose={() => onOpenChange(false)} />
    </Dialog>
  )
}
