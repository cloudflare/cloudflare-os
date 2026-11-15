import { KeepChangesCard } from '@/blocks/KeepChangesCard'
import type { ActionResult } from '@/blocks/usePending'
import type { KeepAsk } from './ChatSession'
import { keepChangeLines, keepReason } from './keepChanges'
import { useChatConnections } from './useChatConnections'

/**
 * A chat's changes waiting to be kept (`KeepChangesCard`), each gadget named by `outputTitle`, and
 * the connections and agent spawners given to them by what the chat can use, read while it waits.
 */
export const KeepAskCard = ({ workspaceId, chatId, keep, outputTitle, onKeep, onDiscard }: {
  workspaceId: string
  chatId: number
  keep: KeepAsk
  outputTitle: (gadgetId: number) => string | undefined
  onKeep: () => ActionResult
  onDiscard: () => ActionResult
}) => {
  const connections = useChatConnections(workspaceId, chatId)
  const connectionTitle = (id: number) =>
    connections.status === 'ready' ? connections.connections.find(({ gatekeeperId }) => gatekeeperId === id)?.title : undefined
  return (
    <KeepChangesCard
      changes={keepChangeLines(keep, (id) => outputTitle(id) ?? connectionTitle(id))}
      reason={keepReason(keep)}
      onKeep={onKeep}
      onDiscard={onDiscard}
    />
  )
}
