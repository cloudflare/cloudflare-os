import { useId } from 'react'
import { Badge } from '@cloudflare/kumo'
import { Globe02Icon, SecurityWarningIcon } from '@/components/icons'
import { Button } from '@gadgets/ui'
import { Card } from '@/components/Card'
import { usePending, type ActionResult } from './usePending'

export type WebFetchRequestCardProps = {
  /** The page, exactly as it will be requested. */
  url: string
} & (
  | {
      state: 'pending'
      /** The workspace has read sensitive data, so whoever approves vouches for the address. */
      restricted?: boolean
      onApprove: () => ActionResult
      onDeny: () => ActionResult
      /** On the last of several waiting: approves this one and the others. */
      approveAll?: { count: number; onApprove: () => ActionResult }
    }
  | { state: 'approved' | 'denied' }
)

/**
 * The agent asking to fetch a page the workspace won't let it reach on its own. Its address is
 * shown whole, since that is what is sent. It stays a card once answered, saying how.
 */
export const WebFetchRequestCard = ({ url, ...props }: WebFetchRequestCardProps) => {
  const [pending, run] = usePending()
  const id = useId()

  return (
    <Card>
      <section aria-labelledby={`${id}-title`} className="contents">
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
            <Globe02Icon aria-hidden="true" className="size-5" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span id={`${id}-title`} className="font-medium text-kumo-default">Fetch a web page</span>
              {props.state === 'approved' && <Badge variant="success">Approved</Badge>}
              {props.state === 'denied' && <Badge variant="error">Denied</Badge>}
            </div>
            <p id={`${id}-url`} className="font-mono text-sm break-all text-kumo-subtle">{url}</p>
          </div>
        </div>
        {props.state === 'pending' && props.restricted && (
          <p id={`${id}-restricted`} role="note" className="flex items-start gap-2 rounded-xl bg-kumo-warning-tint px-3 py-2 text-sm text-kumo-default">
            <SecurityWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-kumo-warning" />
            This workspace has read sensitive data. Read the whole address before approving: you are responsible for making sure it contains none of that data.
          </p>
        )}
        {props.state === 'pending' && (
          <div className="flex flex-wrap justify-end gap-2">
            {props.approveAll && (
              <Button variant="ghost" disabled={pending} onClick={() => run(props.approveAll!.onApprove)} className="me-auto">
                Approve all {props.approveAll.count}
              </Button>
            )}
            <Button disabled={pending} aria-describedby={`${id}-url`} onClick={() => run(props.onDeny)}>Deny</Button>
            <Button
              variant="primary"
              disabled={pending}
              aria-describedby={[`${id}-url`, props.restricted && `${id}-restricted`].filter(Boolean).join(' ')}
              onClick={() => run(props.onApprove)}
            >
              Approve
            </Button>
          </div>
        )}
      </section>
    </Card>
  )
}
