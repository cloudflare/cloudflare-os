import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import type { Agent } from '@/automations/agents'
import { WorkspaceInsideNav, type InsideAgent, type InsideGadget, type MoreLink } from '@/blocks/WorkspaceInsideNav'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { useApi } from '@/rpc/ApiContext'
import type { SidebarChatLinks } from './SidebarChats'
import { useSidebarChats } from './useSidebarChats'
import { useWorkspaceGadgets } from './useWorkspaceGadgets'
import { useWorkspaceMemberships } from './useWorkspaceMemberships'
import { workspaceLabel } from './workspaceLabel'

/** How the workspace's things in the sidebar go places, past its chats (`SidebarChatLinks`). */
export type InsideLinks = SidebarChatLinks & {
  gadgetHref: (item: AsideItem) => string
  onOpenGadget: (item: AsideItem) => void
  agentHref: (agentKey: string) => string
  onOpenAgent: (agentKey: string) => void
  /** The workspace page's tab for each section. */
  more: { chats: MoreLink; gadgets: MoreLink; agents: MoreLink }
}

export type WorkspaceInsideSidebarProps = {
  workspace: WorkspaceMetadataWithTimestamps
  look?: WorkspaceLook
  /** What waits on the viewer in it, in words (`waitingWords`), said under its title. */
  attention?: string
  /** What is on screen. */
  current: { chatId?: number; newChat?: boolean; gadgetKey?: string; agentKey?: string }
  /** How many things a gadget asks that wait on the viewer, by its workpiece. */
  gadgetWaiting: (workpieceId: number) => number
  links: InsideLinks
}

const COUNT = new Intl.NumberFormat('en')
const firstName = (name: string) => name.split(' ')[0] || name

/** How an agent stands, in a word or two: what of it wants the viewer, that it works, or its runs. */
const agentStatus = ({ waiting, failed, running, runs }: Agent) =>
  waiting > 0 ? { status: `${COUNT.format(waiting)} waiting`, wantsAttention: true }
    : failed ? { status: 'Failed', wantsAttention: true }
      : running > 0 ? { status: 'Working…', wantsAttention: false }
        : { status: runs.length === 0 ? 'No runs' : runs.length === 1 ? '1 run' : `${COUNT.format(runs.length)} runs`, wantsAttention: false }

/**
 * Everything of one workspace's in the sidebar (`WorkspaceInsideNav`) while something of it is on
 * screen: its chats, with what was said in each last, its gadgets, with what each asks of the
 * viewer, and its agents with their runs, from the chats; and under its title, what waits on the
 * viewer in it or who it is shared with.
 */
export const WorkspaceInsideSidebar = ({ workspace, look, attention, current, gadgetWaiting, links }: WorkspaceInsideSidebarProps) => {
  const { user } = useApi()
  const builds = workspace.role !== 'use'
  const data = useSidebarChats(workspace.id, builds, links.chatHref, { currentChatId: current.chatId, previews: true })
  const made = useWorkspaceGadgets(workspace.id)
  const members = useWorkspaceMemberships([workspace]).get(workspace.id)
  const others = members?.filter(({ profile }) => profile.id !== user.id)
  const shared = others === undefined
    ? undefined
    : others.length === 0 ? 'Just you' : others.length === 1 ? `You and ${firstName(others[0].profile.name)}` : `You and ${COUNT.format(others.length)} others`

  const gadgets = made?.flatMap((item): InsideGadget[] => item.kind !== 'output' ? [] : [{
    key: item.key,
    title: item.title,
    noun: item.output.format?.noun,
    icon: item.output.format?.icon,
    waiting: gadgetWaiting(item.output.workpieceId),
    href: links.gadgetHref(item),
  }])
  const byKey = new Map(made?.map((item) => [item.key, item]))
  const agents = data.status === 'ready'
    ? data.agents.map((agent): InsideAgent => ({
        key: agent.key,
        name: agent.name,
        ...agentStatus(agent),
        working: agent.running > 0,
        failed: agent.failed,
        href: links.agentHref(agent.key),
        runs: agent.runs.map((run) => ({ id: run.chatId, title: run.title, waiting: run.status === 'waiting', href: links.chatHref(run.chatId) })),
      }))
    : []

  return (
    <WorkspaceInsideNav
      workspace={{
        title: workspace.title,
        workspaceLabel: workspaceLabel(workspace.title),
        workspaceLook: look,
        subtitle: attention ?? shared,
        attention: attention !== undefined,
        href: links.workspaceHref,
        onOpen: links.onOpenWorkspace,
      }}
      chats={data.status === 'ready' ? { status: 'ready', chats: data.chats, agents } : data}
      gadgets={gadgets}
      current={current}
      onOpenChat={links.onOpenChat}
      onOpenGadget={(gadget) => {
        const item = byKey.get(gadget.key)
        if (item) links.onOpenGadget(item)
      }}
      onOpenAgent={(agent) => links.onOpenAgent(agent.key)}
      onOpenRun={links.onOpenChat}
      newChat={{ href: links.newChatHref, onOpen: links.onNewChat }}
      more={links.more}
    />
  )
}
