import { Link } from '@tanstack/react-router'
import { Clock } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { roundButtonClass } from '../../components/RoundButton'
import { useAutomations } from './AutomationList'

/**
 * Beside a chat's title, once the chat has automations: a clock, with how many are on, that opens
 * the chat's Automations tab. Absent until there is one, so most chats' headers stay as they were.
 */
export function ChatAutomationsLink({ overseer, workspaceId, chatId, gadgetIds }: {
  overseer: RpcStub<Overseer>
  workspaceId: string
  chatId: number
  /** The apps the chat built, whose automations are the chat's too. */
  gadgetIds?: readonly WorkpieceId[]
}) {
  const { hooks } = useAutomations(overseer, { chatId, gadgetIds })
  if (!hooks?.length) return null
  const on = hooks.filter(hook => hook.enabled).length
  const label = hooks.length === 1
    ? `${hooks[0]!.description.title}${on ? '' : ' (paused)'}`
    : `${hooks.length} automations${on < hooks.length ? `, ${on} on` : ''}`
  return (
    <Link
      to="/workspace/$id"
      params={{ id: workspaceId }}
      search={{ chat: chatId, details: 'automations' }}
      title={label}
      aria-label={`Automations: ${label}`}
      className={roundButtonClass('pill', `h-11 shrink-0 !gap-1.5 !px-2.5 !text-[13px] ring-kumo-line md:!h-9 md:ring-kumo-tint ${on ? 'text-kumo-default' : 'text-kumo-subtle'}`)}
    >
      <Clock size={16} weight={on ? 'regular' : 'light'} />
      {hooks.length > 1 && <span className="tabular-nums">{hooks.length}</span>}
    </Link>
  )
}
