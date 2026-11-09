import { useId, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { GlobeIcon } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, Overseer } from '@gadgets/workshop-shared/api'
import { ChatReceipt, RequestButton, RequestCard } from '../chat/transcript/RequestCard'
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

  let host = request.url
  try {
    host = new URL(request.url).host
  } catch {
    // Shown as given.
  }

  if (!pending) {
    return (
      <ChatReceipt icon={<GlobeIcon size={15} />} title={request.url}>
        {request.state === 'approved' ? `Opened ${host}` : `Didn't open ${host}`}
      </ChatReceipt>
    )
  }

  return (
    <RequestCard
      icon={<GlobeIcon size={17} />}
      title="Open a web page"
      meta={host}
      actions={
        <>
          <RequestButton tone="secondary" onClick={() => void decide(false, [request.requestId])}
            disabled={deciding} aria-describedby={`${noticeId} ${urlId}`}>
            Deny
          </RequestButton>
          <RequestButton tone="primary" onClick={() => void decide(true, [request.requestId])}
            disabled={deciding} aria-describedby={`${noticeId} ${urlId}`}>
            Approve
          </RequestButton>
        </>
      }
      footer={
        <>
          <RestrictedApprovalNotice id={noticeId} />
          {offerApproveAll && (
            <div className="mt-2 flex justify-end">
              <RequestButton tone="quiet" onClick={() => void decide(true, pendingRequestIds)} disabled={deciding}>
                Approve all {pendingRequestIds.length}
              </RequestButton>
            </div>
          )}
        </>
      }
    >
      <span id={urlId} className="break-all">{request.url}</span>
    </RequestCard>
  )
}
