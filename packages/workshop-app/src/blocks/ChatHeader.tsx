import { CaretRightIcon, ClockIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { AgentsBubble, type AgentsBubbleProps } from './AgentsBubble'
import { AgentCrumb, type AgentCrumbProps } from './AgentCrumb'
import { ChatMoreMenu, type ChatMoreMenuProps } from './ChatMoreMenu'
import { WorkspaceCrumb } from './WorkspaceCrumb'

export type ChatHeaderProps = {
  /** The workspace the chat is in, once it is known. */
  workspace?: {
    id: string
    title: string
    /** Two letters shown on the icon. */
    label: string
    /** How its icon is drawn, when not as any workspace's is. */
    look?: WorkspaceLook
    onOpen: () => void
  }
  /** The agent whose run the chat is, where it is one, which goes to the agent's page. */
  agent?: AgentCrumbProps
  /** The chat's title, once it is known. */
  title?: string
  /** Opens the chat's settings, from its title. */
  onOpenSettings?: () => void
  /** What the chat has set up to run by itself, while there is any: how many, and the way to them. */
  automations?: { count: number; onOpen: () => void }
  /**
   * The agents the chat's gadgets start, beside the clock: one by its name, opening its page;
   * several by how many, opening the workspace's Agents.
   */
  agents?: AgentsBubbleProps
  /** What else can be done with the chat (`ChatMoreMenu`), for whoever may do any of it. */
  more?: Pick<ChatMoreMenuProps, 'read' | 'notifications' | 'onDelete'>
}

/**
 * A chat's header: the way back to its workspace, and for an agent's run to its agent, then the
 * chat's title, which opens its settings,
 * and while the chat has set something up to run by itself, a clock with how many, which opens
 * them; then the agents its gadgets start. Each is a bubble of its own, so it pops in as the first
 * is set up. Last, once the
 * title is there, more: marking it unread, its notifications and deleting it.
 */
export const ChatHeader = ({ workspace, agent, title, onOpenSettings, automations, agents, more }: ChatHeaderProps) => (
  <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
    {workspace && <WorkspaceCrumb {...workspace} />}
    {agent && <AgentCrumb {...agent} />}
    {title && (
      // Cut off where there is not room for all of it, as on a phone.
      <HeaderBubble className="min-w-0">
        <Button title={onOpenSettings && 'Chat settings'} onClick={onOpenSettings} className="min-w-0 shrink">
          {/* Wrapped, so the caret keeps a chevron's size rather than an icon's. */}
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{title}</span>
            {onOpenSettings && <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />}
          </span>
        </Button>
      </HeaderBubble>
    )}
    {automations && (
      <HeaderBubble className="shrink-0">
        <Button
          icon={ClockIcon}
          aria-label={automations.count === 1 ? 'Automations: 1' : `Automations: ${automations.count}`}
          title="Automations"
          onClick={automations.onOpen}
        >
          {automations.count}
        </Button>
      </HeaderBubble>
    )}
    {agents && <AgentsBubble {...agents} />}
    {title && more && (more.read || more.notifications?.choices.length || more.onDelete) && (
      <HeaderBubble className="shrink-0">
        <ChatMoreMenu title={title} {...more} triggerVariant="secondary" />
      </HeaderBubble>
    )}
  </nav>
)
