import { useState } from 'react'
import { Badge } from '@cloudflare/kumo'
import { PlugsIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { Card } from '@/components/Card'
import { usePending, type ActionResult } from './usePending'

export type ConnectionRequestCardProps = {
  vendorName: string
  logoUrl?: string
  /** What is being asked for: the kind of resource, or its address. */
  scope?: string
  /** Why the agent wants it, in its own words. */
  reason: string
} & (
  | { state: 'pending'; onSetUp: () => ActionResult; onDeny: () => ActionResult }
  | { state: 'connected' | 'denied' }
)

/**
 * The agent asking for access to something the user has not connected. It stays a card once
 * answered, saying how, so the answer stands out in the conversation.
 */
export const ConnectionRequestCard = ({ vendorName, logoUrl, scope, reason, ...props }: ConnectionRequestCardProps) => {
  const [pending, run] = usePending()
  const [logoFailed, setLogoFailed] = useState(false)

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-kumo-fill text-kumo-default">
          {logoUrl && !logoFailed
            ? <img src={logoUrl} alt="" className="size-6 object-contain" onError={() => setLogoFailed(true)} />
            : <PlugsIcon aria-hidden="true" className="size-5" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-kumo-default">Connect {vendorName}</span>
            {scope && <Badge variant="outline">{scope}</Badge>}
            {props.state === 'connected' && <Badge variant="success">Connected</Badge>}
            {props.state === 'denied' && <Badge variant="error">Denied</Badge>}
          </div>
          {reason && <p className="text-sm text-kumo-subtle">{reason}</p>}
        </div>
      </div>
      {props.state === 'pending' && (
        <div className="flex justify-end gap-2">
          <Button disabled={pending} onClick={() => run(props.onDeny)}>Deny</Button>
          <Button variant="primary" disabled={pending} onClick={() => run(props.onSetUp)}>Set up</Button>
        </div>
      )}
    </Card>
  )
}
