import { ArrowRight01Icon } from '@/components/icons'
import { Button, HeaderBubble } from '@gadgets/ui'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { AgentsBubble, type AgentsBubbleProps } from './AgentsBubble'
import { AgentCrumb, type AgentCrumbProps } from './AgentCrumb'
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
  /**
   * The agents the chat's gadgets start, after the title: one by its name, opening its page;
   * several by how many, opening the workspace's Agents.
   */
  agents?: AgentsBubbleProps
}

/**
 * A chat's header: the way back to its workspace, and for an agent's run to its agent, then the
 * chat's title, which opens its settings, then the agents its gadgets start. Each is a bubble of
 * its own, so it pops in as the first is set up.
 */
export const ChatHeader = ({ workspace, agent, title, onOpenSettings, agents }: ChatHeaderProps) => (
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
            {onOpenSettings && <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 text-kumo-subtle" />}
          </span>
        </Button>
      </HeaderBubble>
    )}
    {agents && <AgentsBubble {...agents} />}
  </nav>
)
