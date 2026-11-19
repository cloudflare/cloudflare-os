import { useId, type MouseEvent } from 'react'
import { Collapsible } from '@cloudflare/kumo/primitives/collapsible'
import { ArrowUpRightIcon, CaretDownIcon, GitMergeIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { usePending, type ActionResult } from './usePending'
import '@/components/Disclosure.css'

/**
 * An app the changes are to: its title and its format's icon where they are known, and how many
 * of its files they change.
 */
export type KeepChangesApp = { gadgetId: number; title?: string; icon?: FormatIconName; files?: number }

export type KeepChangesCardProps = {
  /** What else the changes do, one line each: "Connects “Tip Jar” to “Platform board”". */
  changes: string[]
  /** What to know before keeping them, where there is something: conflicts, a connection given. */
  reason?: string
  onKeep: () => ActionResult
  /** Edits are still on their way into them, which keeping now would leave out: Keep waits. */
  sending?: boolean
  /** Throws them away, once the user has said so again: what is discarded is gone. */
  onDiscard: () => void
  /** The apps the changes are to, which are kept or discarded together. */
  apps?: KeepChangesApp[]
  /** Opens one of them beside the chat, to look it over before keeping them. */
  onOpen?: (gadgetId: number) => void
  /** It is open to what the changes are, which it is not to start with. */
  open: boolean
  onToggle: () => void
}

// A click on the card that is not on something of its own, nor among its answers (a disabled one
// lets the click through), nor the end of choosing text, nor one from a menu it opened, which is
// elsewhere on the page.
const onCard = (event: MouseEvent<HTMLElement>) =>
  event.target instanceof Element && event.currentTarget.contains(event.target) &&
  !event.target.closest('button, a, input, textarea, select, label, [role="button"], [role="menuitem"], [data-answers]') &&
  !window.getSelection()?.toString()

const plural = (count: number, one: string) => `${count} ${count === 1 ? one : `${one}s`}`

const questionOf = (apps: readonly KeepChangesApp[]) =>
  apps.length > 1 ? `Keep changes to ${plural(apps.length, 'app')}?`
    : apps[0]?.title ? `Keep changes to ${apps[0].title}?` : 'Keep these changes?'

const AppRow = ({ app, onOpen }: { app: KeepChangesApp; onOpen?: (gadgetId: number) => void }) => {
  const content = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
        <FormatIcon name={app.icon} className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-kumo-default">{app.title || 'Untitled app'}</span>
      {app.files !== undefined && app.files > 0 && <span className="shrink-0 text-sm text-kumo-subtle">{plural(app.files, 'file')}</span>}
    </>
  )
  if (!onOpen) return <span className="flex items-center gap-2.5 p-1.5 pe-3">{content}</span>
  return (
    <button
      type="button"
      onClick={() => onOpen(app.gadgetId)}
      className="group flex w-full cursor-pointer items-center gap-2.5 rounded-xl p-1.5 pe-3 text-left outline-none hover:bg-kumo-tint focus-visible:ring-2 focus-visible:ring-kumo-ring"
    >
      {content}
      <ArrowUpRightIcon aria-hidden="true" weight="bold" className="size-4 shrink-0 text-kumo-subtle group-hover:text-kumo-default" />
    </button>
  )
}

/**
 * A chat's changes, waiting for the user at the end of the conversation, as nothing is kept until
 * someone keeps it: the question, with its two answers, which are for everything the chat changed
 * at once, as its changes are only kept or discarded whole. It opens to what they are, for
 * whoever does not remember what they asked for: what to know before keeping them, each app they
 * change, opened beside the chat from its row, and what else they do. Keep waits for edits still
 * on their way, which it would otherwise leave out. Where the question has no room for its
 * answers beside it, they come last, under what it opens to. Discarding asks again, as what is
 * discarded cannot be had back.
 */
export const KeepChangesCard = ({ changes, reason, onKeep, sending, onDiscard, apps = [], onOpen, open, onToggle }: KeepChangesCardProps) => {
  const id = useId()
  const [pending, run] = usePending()
  return (
    // Beside the question where there is room, else under what it opens to, last, halving the width.
    <div className="@container">
      <Card className="grid cursor-pointer grid-cols-1 @md:grid-cols-[minmax(0,1fr)_auto] @md:gap-x-6" onClick={(event) => onCard(event) && onToggle()}>
        <Collapsible.Root open={open} onOpenChange={(next) => next !== open && onToggle()} className="contents">
          <section aria-labelledby={`${id}-title`} className="contents">
            <div className="flex min-w-0 items-center gap-3 self-center">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
                <GitMergeIcon aria-hidden="true" className="size-5" />
              </span>
              <h3 id={`${id}-title`} className="flex min-w-0 font-medium text-kumo-default">
                <Collapsible.Trigger className="group -mx-2 flex min-w-0 cursor-pointer items-center gap-2 rounded-full px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
                  <span className="min-w-0 break-words">{questionOf(apps)}</span>
                  <CaretDownIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0 text-kumo-default transition-transform group-data-panel-open:rotate-180 motion-reduce:transition-none" />
                </Collapsible.Trigger>
              </h3>
            </div>
            {/* Read straight after the question, as they are set beside it; set out last where they are not. */}
            <div data-answers className="order-last grid grid-cols-2 gap-2 @md:order-none @md:col-start-2 @md:row-start-1 @md:flex @md:items-center">
              <ConfirmMenu
                label="Discard"
                triggerVariant="secondary"
                triggerClassName="w-full @md:w-auto"
                title="Discard these changes?"
                description="Everything this chat changed since its changes were last kept goes, and can’t be had back."
                confirmLabel="Discard"
                onConfirm={onDiscard}
                disabled={pending}
              />
              <Button
                variant="primary"
                className="w-full @md:w-auto"
                disabled={pending || sending}
                title={sending ? 'Your edits are still being saved' : undefined}
                aria-describedby={reason ? `${id}-reason` : undefined}
                onClick={() => run(onKeep)}
              >
                Keep
              </Button>
            </div>
            {/* Folded, what to know first still describes Keep, unseen. */}
            {reason && !open && <p id={`${id}-reason`} className="sr-only">{reason}</p>}
            <Collapsible.Panel className="disclosure-panel @md:col-span-2 @md:row-start-2">
              <div className="-mx-4 flex flex-col gap-3 border-t border-kumo-line px-4 pt-3">
                {reason && open && <p id={`${id}-reason`} className="text-sm text-kumo-subtle">{reason}</p>}
                {apps.length > 0 && (
                  <ul aria-label="Apps it changes" className="-mx-1.5 flex flex-col gap-0.5">
                    {apps.map((app) => <li key={app.gadgetId}><AppRow app={app} onOpen={onOpen} /></li>)}
                  </ul>
                )}
                {changes.length > 0 && (
                  <ul className="flex flex-col gap-1 text-sm text-kumo-default">
                    {changes.map((change) => <li key={change}>{change}</li>)}
                  </ul>
                )}
              </div>
            </Collapsible.Panel>
          </section>
        </Collapsible.Root>
      </Card>
    </div>
  )
}
