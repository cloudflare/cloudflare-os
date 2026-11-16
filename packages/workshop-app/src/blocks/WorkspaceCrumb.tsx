import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { HeaderCrumb } from './HeaderCrumb'

export type WorkspaceCrumbProps = {
  id: string
  title: string
  /** Two letters shown on the icon. */
  label: string
  /** How its icon is drawn, when not as any workspace's is. */
  look?: WorkspaceLook
  /** Shows the title beside the icon. Otherwise the crumb is the icon alone, in a circle. */
  expanded?: boolean
  onOpen?: () => void
}

/**
 * A workspace in a page's header (`HeaderCrumb`): its icon, and on its own page its title too.
 * Going between a workspace and one of its chats keeps the crumb, which grows the title out of the
 * icon or draws it back in. Going to another workspace swaps the crumb for that one's.
 */
export const WorkspaceCrumb = ({ id, title, label, look, expanded, onOpen }: WorkspaceCrumbProps) => (
  <HeaderCrumb name={`workspace:${id}`} icon={<WorkspaceIcon label={label} {...look} small />} title={title} expanded={expanded} onOpen={onOpen} />
)
