import { KindMark } from '@/components/KindMark'
import { HeaderCrumb } from './HeaderCrumb'

export type AgentCrumbProps = {
  /** Its connection, in its workspace (`workspaceId`). */
  id: number
  workspaceId: string
  /** What its agents are called: "Joke". */
  name: string
  /** Shows its name beside its mark, as on its own page. Otherwise the crumb is the mark alone. */
  expanded?: boolean
  onOpen?: () => void
}

/**
 * An agent in a page's header (`HeaderCrumb`), after its workspace's: its spark, and on its own
 * page its name too. Going between the agent and one of its runs keeps the crumb, which draws the
 * name back into the spark or grows it out, as a workspace's does for its chats.
 */
export const AgentCrumb = ({ id, workspaceId, name, expanded, onOpen }: AgentCrumbProps) => (
  <HeaderCrumb name={`agent:${workspaceId}/${id}`} icon={<KindMark name="agent" className="size-[1.125em]" />} title={name} expanded={expanded} onOpen={onOpen} />
)
