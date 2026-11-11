import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import type { MockOverseer } from './MockOverseer'
import type { Trigger } from './scenario'

/** Does what a step is waiting for, the way a user would from the chat. */
const act = async (overseer: MockOverseer, trigger: Trigger, messages: AiChatMessage[]) => {
  const pendingAction = messages.find((message) => message.type === 'action' && message.actionLog?.state === 'pending')
  const pendingRequest = messages.find((message) => message.type === 'connectionRequest' && message.state === 'pending')
  switch (trigger) {
    case 'onStart':
      return
    case 'onSend':
      return overseer.sendChatMessage(0, 'And then?')
    case 'onRetry':
      return overseer.retryAgent()
    case 'onStop':
      return overseer.stopAgent()
    case 'onApprove':
    case 'onDeny': {
      if (pendingAction?.type !== 'action') throw new Error(`Nothing is pending for ${trigger}.`)
      return trigger === 'onApprove' ? overseer.approveAction(pendingAction.actionId) : overseer.rejectAction(pendingAction.actionId)
    }
    case 'onAcceptConnection':
    case 'onDenyConnection': {
      if (pendingRequest?.type !== 'connectionRequest') throw new Error(`Nothing is pending for ${trigger}.`)
      return trigger === 'onAcceptConnection'
        ? overseer.acceptConnectionRequest(pendingRequest.requestId, { gatekeeperId: 1 })
        : overseer.denyConnectionRequest(pendingRequest.requestId)
    }
  }
}

/**
 * Runs a scenario's whole script at once, acting for the user wherever a step waits for them.
 * `afterStep` sees the chat after every step, e.g. to check what is on screen along the way.
 */
export const playThrough = async (overseer: MockOverseer, afterStep?: () => void): Promise<AiChatMessage[]> => {
  const { player } = overseer
  for (;;) {
    const { position, total, waitingFor } = player.getSnapshot()
    if (position === total) break
    if (waitingFor) await act(overseer, waitingFor[0], (await overseer.getChatHistory(0)).messages)
    player.step()
    afterStep?.()
  }
  return (await overseer.getChatHistory(0)).messages
}
