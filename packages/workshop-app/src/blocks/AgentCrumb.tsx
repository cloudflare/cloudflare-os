import { RobotIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'

export type AgentCrumbProps = {
  /** Which agent, so that its crumb on one page carries on from its crumb on the next. */
  agentKey: string
  name: string
  /** Goes to the agent's page; absent on that page itself. */
  onOpen?: () => void
}

/**
 * An agent in a page's header, after its workspace's crumb: a robot and its name. On a run's page
 * it goes to the agent's, and going between the two keeps the crumb, as the workspace's is kept.
 */
export const AgentCrumb = ({ agentKey, name, onOpen }: AgentCrumbProps) => (
  <HeaderBubble name={`agent:${agentKey}`} className="min-w-0">
    <Button icon={RobotIcon} title={onOpen ? 'Agent' : undefined} onClick={onOpen} className="min-w-0 shrink">
      <span className="truncate">{name}</span>
    </Button>
  </HeaderBubble>
)
