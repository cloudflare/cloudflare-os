import { useId, useState } from 'react'
import { Button, useKumoToastManager } from '@cloudflare/kumo'
import { GlobeIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, Overseer } from '@gadgets/workshop-shared/api'
import { ResolveButton } from '../../components/ResolveButton'
import { RestrictedApprovalNotice } from '../../components/RestrictedApprovalNotice'
import { rpcFailureDescription } from '../../rpcErrors'

/** An agent's request to fetch a URL that its restricted workspace would otherwise refuse. */
export const WebFetchRequestCard = ({ overseer, request, pendingRequestIds }: {
  overseer: RpcStub<Overseer>
  request: AiChatMessage & { type: 'webFetchRequest' }
  /** Every pending web fetch request in the chat, oldest first, for "Approve all". */
  pendingRequestIds: string[]
}) => {
  const [deciding, setDeciding] = useState(false)
  const toasts = useKumoToastManager()
  const noticeId = useId()
  const urlId = useId()
  const pending = request.state === 'pending'
  // The agent resumes once every request is decided, so one card offers to approve them all.
  const offerApproveAll = pending && pendingRequestIds.length > 1 &&
      pendingRequestIds.at(-1) === request.requestId

  const decide = async (approve: boolean, requestIds: string[]) => {
    setDeciding(true)
    try {
      for (const id of requestIds) {
        await (approve ? overseer.approveWebFetchRequest(id) : overseer.denyWebFetchRequest(id))
      }
    } catch (err) {
      toasts.add({
        title: approve ? 'Failed to approve the web fetch' : 'Failed to deny the web fetch',
        description: rpcFailureDescription(err),
        variant: 'error',
      })
    } finally {
      setDeciding(false)
    }
  }

  return (
    <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-start gap-3">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-kumo-subtle">
            <GlobeIcon size={18} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-kumo-default">Fetch a web page</span>
              {request.state === 'approved' && (
                <span className="text-[12px] font-medium text-kumo-success">Approved</span>
              )}
              {request.state === 'denied' && (
                <span className="text-[12px] font-medium text-kumo-danger">Denied</span>
              )}
            </div>
            <p id={urlId} className="m-0 mt-1 break-all font-mono text-[12px] leading-[18px] text-kumo-default">
              {request.url}
            </p>
          </div>
          {pending && (
            <div className="ml-3 flex shrink-0 items-center gap-1 self-center">
              <ResolveButton
                tone="deny"
                onClick={() => void decide(false, [request.requestId])}
                disabled={deciding}
                describedBy={`${noticeId} ${urlId}`}
              />
              <ResolveButton
                tone="approve"
                variant="filled"
                onClick={() => void decide(true, [request.requestId])}
                disabled={deciding}
                describedBy={`${noticeId} ${urlId}`}
              />
            </div>
          )}
        </div>
        {pending && <RestrictedApprovalNotice id={noticeId} className="mt-3" />}
        {offerApproveAll && (
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void decide(true, pendingRequestIds)}
              disabled={deciding}
            >
              Approve all {pendingRequestIds.length}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
