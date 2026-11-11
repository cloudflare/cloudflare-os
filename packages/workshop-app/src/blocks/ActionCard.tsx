import { useId } from 'react'
import { Badge } from '@cloudflare/kumo'
import { ShieldCheckIcon, ShieldWarningIcon, WarningIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { Disclosure } from '@/components/Disclosure'
import { Markdown } from '@/components/Markdown'
import { ActionFields, type ActionField } from './ActionFields'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import { usePending, type ActionResult } from './usePending'

type Request = {
  title: string
  /** The gatekeeper's own account of what the action does, as Markdown. */
  description: string
  resource?: ResourceLinkProps
  fields: ActionField[]
}

export type ActionCardProps = Request & (
  | {
      state: 'pending'
      /** Part of what the action will send is not in its description. */
      incomplete?: boolean
      /** The workspace has read sensitive data: the request is shown in full, to be read before approving. */
      restricted?: boolean
      onApprove: () => ActionResult
      onDeny: () => ActionResult
      /** Approve this kind of action from now on. Not offered in a restricted workspace. */
      onAlwaysApprove?: () => ActionResult
    }
  | {
      state: 'approved' | 'denied'
      /** Who decided it, e.g. "Approved by Ada". */
      resolution: string
      open: boolean
      onToggle: () => void
    }
)

const Note = ({ id, tone, children }: { id: string; tone: 'warning' | 'caution'; children: string }) => {
  const NoteIcon = tone === 'warning' ? ShieldWarningIcon : WarningIcon
  return (
    <p id={id} role="note" className="flex items-start gap-2 rounded-xl bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-default">
      <NoteIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kumo-warning" />
      {children}
    </p>
  )
}

const RequestBody = ({ description, fields, uncapped }: Pick<Request, 'description' | 'fields'> & { uncapped?: boolean }) => (
  <>
    {description && <div className="text-sm text-kumo-default"><Markdown>{description}</Markdown></div>}
    <ActionFields fields={fields} uncapped={uncapped} />
  </>
)

/**
 * Something the agent wants to do outside the workspace. While it waits for a decision it is a
 * card with everything needed to decide. Once decided it stays a card that says how, with the
 * request folded away, so the decision stands out in the conversation without filling it.
 */
export const ActionCard = (props: ActionCardProps) => {
  const { title, description, resource, fields } = props
  const [pending, run] = usePending()
  const id = useId()
  const heading = (
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
        <ShieldCheckIcon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id={`${id}-title`} className="font-medium text-kumo-default">{title}</h3>
          {props.state !== 'pending' && (
            <Badge variant={props.state === 'approved' ? 'success' : 'error'}>{props.resolution}</Badge>
          )}
        </div>
        {resource ? <ResourceLink {...resource} /> : props.state === 'pending' && <span className="text-sm text-kumo-subtle">Needs your approval</span>}
      </div>
    </div>
  )

  if (props.state !== 'pending') {
    return (
      <Card>
        <section aria-labelledby={`${id}-title`} className="contents">
          {heading}
          {(description || fields.length > 0) && (
            <Disclosure open={props.open} onToggle={props.onToggle} summary="Request" className="-mx-2 -my-1">
              <div className="mx-2 mt-2 mb-1 flex flex-col gap-3">
                <RequestBody description={description} fields={fields} />
              </div>
            </Disclosure>
          )}
        </section>
      </Card>
    )
  }

  const { restricted, incomplete, onApprove, onDeny, onAlwaysApprove } = props
  // The notices and the request are what the buttons act on, so they describe them.
  const describedBy = [restricted && `${id}-restricted`, `${id}-request`, incomplete && `${id}-incomplete`].filter(Boolean).join(' ')

  return (
    <Card>
      <section aria-labelledby={`${id}-title`} className="contents">
        {heading}
        {restricted && (
          <Note id={`${id}-restricted`} tone="warning">
            This workspace has read sensitive data. Read the full request before approving: you are responsible for making sure it contains none of that data.
          </Note>
        )}
        <div id={`${id}-request`} className="flex flex-col gap-3">
          <RequestBody description={description} fields={fields} uncapped={restricted} />
        </div>
        {incomplete && (
          <Note id={`${id}-incomplete`} tone="caution">
            This description is incomplete: part of what this action will send isn’t shown.
          </Note>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {onAlwaysApprove && !restricted && (
            <Button variant="ghost" disabled={pending} onClick={() => run(onAlwaysApprove)} className="me-auto">
              Always approve
            </Button>
          )}
          <Button disabled={pending} aria-describedby={describedBy} onClick={() => run(onDeny)}>Deny</Button>
          <Button variant="primary" disabled={pending} aria-describedby={describedBy} onClick={() => run(onApprove)}>Approve</Button>
        </div>
      </section>
    </Card>
  )
}
