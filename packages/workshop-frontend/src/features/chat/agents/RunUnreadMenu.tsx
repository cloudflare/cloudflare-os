import { DropdownMenu } from '@cloudflare/kumo'
import { DotsThreeVertical } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AiChatMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { WorkshopIconButton } from '../../../components/WorkshopControls'
import { UnreadBadge } from '../../notifications/UnreadBadge'
import { unreadCountOf, useUnreadState } from '../../notifications/UnreadStateBridge'

/**
 * What a run has left unread, and the control that sets it.
 *
 * A run is a thread you read, or mean to come back to, like any other. Rename and Delete are left
 * to the run's own sub-header, which has both: four items is more than a row this narrow should
 * hold.
 *
 * Renders as a sibling of the row's button rather than inside it, since a control nested in a
 * button is neither valid nor reachable.
 */
export const RunUnreadMenu = ({ workspaceId, run, overseer }: {
  /** Absent off a workspace, where there are no unread rows to count. */
  workspaceId: string | undefined
  run: AiChatMetadata
  overseer: RpcStub<Overseer>
}) => {
  const unread = useUnreadState()
  const count = unreadCountOf(unread, workspaceId, run.id)

  return (
    <>
      <UnreadBadge count={count} />
      <DropdownMenu>
        <DropdownMenu.Trigger
          render={
            <WorkshopIconButton
              aria-label={`Actions for ${run.title}`}
              onClick={event => event.stopPropagation()}
              className="!h-7 !w-7 flex-shrink-0 text-kumo-inactive opacity-100 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100 sm:!h-6 sm:!w-6 sm:opacity-0"
            >
              <DotsThreeVertical size={13} />
            </WorkshopIconButton>
          }
        />
        <DropdownMenu.Content
          onClick={event => event.stopPropagation()}
          className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1"
        >
          {/* `chats` is absent until this view has cursors, and a receipt cannot be sent without
              one, so both items wait for it rather than failing on the server. */}
          <DropdownMenu.Item
            disabled={!unread?.chats || count === 0}
            onClick={() => { void unread?.markRead(overseer, run.id).catch(() => {}) }}
          >
            Mark thread read
          </DropdownMenu.Item>
          <DropdownMenu.Item
            disabled={!unread?.chats || count > 0}
            onClick={() => { void unread?.markUnread(overseer, run.id).catch(() => {}) }}
          >
            Mark thread unread
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu>
    </>
  )
}
