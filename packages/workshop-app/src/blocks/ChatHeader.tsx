import { ArrowLeft02Icon, ArrowRight01Icon } from '@/components/icons'
import { Button, HeaderBubble } from '@gadgets/ui'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { AgentCrumb, type AgentCrumbProps } from './AgentCrumb'
import { WorkspaceCrumb } from './WorkspaceCrumb'

export type ChatHeaderProps = {
  /**
   * Back to the chat whose agent started this one, an agent's run, first of all. That chat is in
   * the workspace, so the workspace's crumb is left out then.
   */
  back?: { onBack: () => void }
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
}

/**
 * A chat's header: for a run another chat's agent started, the way back to that chat in place of
 * the way to its workspace; else the way to its workspace; for an agent's run the way to its agent, then the chat's title, which opens its
 * settings. Each is a bubble of its own, so it pops in as the
 * first is set up.
 */
export const ChatHeader = ({ back, workspace, agent, title, onOpenSettings }: ChatHeaderProps) => (
  <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
    {back && (
      <HeaderBubble name="back" className="shrink-0">
        <Button icon={ArrowLeft02Icon} aria-label="Back to the chat that started it" title="Back to the chat that started it" onClick={back.onBack} />
      </HeaderBubble>
    )}
    {workspace && !back && <WorkspaceCrumb {...workspace} />}
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
  </nav>
)
