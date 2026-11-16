import { CaretRightIcon, ClockIcon, ExportIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { AgentCrumb, type AgentCrumbProps } from './AgentCrumb'
import { AgentsMenu, type AgentsMenuProps } from './AgentsMenu'
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
  /** The agent whose run the chat is, after the workspace: the way to its page. */
  agent?: AgentCrumbProps
  /** The chat's title, once it is known. */
  title?: string
  /** Opens the chat's settings, from its title. */
  onOpenSettings?: () => void
  /** What the chat set up to run by itself, while it has any: a clock that opens them. */
  automations?: { count: number; onOpen: () => void }
  /**
   * The agents the chat's agent started (`AgentsMenu`), while there are any: in the clock's place,
   * as its menu ends with the chat's automations.
   */
  agents?: Omit<AgentsMenuProps, 'title' | 'compact'>
  /** Shares the workspace the chat is in, from the header's far end. */
  onShare?: () => void
}

/**
 * A chat's header: the way back to its workspace, and for an agent's run to the agent, then the chat's title, which opens its settings,
 * and at the far end a clock while the chat has automations, which opens them, or the agents it
 * started and when they last ran, which lead to them and its automations, and the way to share
 * the workspace. Each is a bubble of the header it is put in, so the clock pops in as the first
 * automation is set up.
 */
export const ChatHeader = ({ workspace, agent, title, onOpenSettings, automations, agents, onShare }: ChatHeaderProps) => {
  const end = agents ? (
    // Its name and when, once the chat is wide enough to spare them from its title.
    <HeaderBubble key="agents" className="ms-auto shrink-0">
      <AgentsMenu {...agents} title={title ?? 'this chat'} compact="fit" />
    </HeaderBubble>
  ) : automations && (
    <HeaderBubble key="automations" className="ms-auto shrink-0">
      <Button
        icon={ClockIcon}
        aria-label={automations.count === 1 ? 'Automations: 1' : `Automations: ${automations.count}`}
        title="Automations"
        onClick={automations.onOpen}
      />
    </HeaderBubble>
  )
  return (
  <>
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
    </nav>
    {end}
    {onShare && (
      <HeaderBubble className={end ? 'shrink-0' : 'ms-auto shrink-0'}>
        <Button icon={ExportIcon} aria-label="Share" title="Share" onClick={onShare} />
      </HeaderBubble>
    )}
  </>
  )
}
