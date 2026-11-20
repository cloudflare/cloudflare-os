import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { agentByKey, agentKeyOf, attentionWords } from '@/automations/agents'
import { useWorkspaceAgents } from '@/automations/useWorkspaceAgents'
import { useDevMode } from '@/hooks/useDevMode'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { CreateTemplate } from '@/library/CreateTemplate'
import { useMadeTemplates } from '@/library/useMadeTemplates'
import { useTemplateOwner } from '@/library/useTemplateOwner'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { GadgetSettingsView, type GadgetSettingsState, type GadgetSettingsTab } from './GadgetSettingsView'
import { InvalidBindingName } from './GadgetSettings'
import { templateUpdateStatus } from './templateUpdate'
import { UpdateFromTemplate } from './UpdateFromTemplate'
import { useBindableModels } from './useBindableModels'
import { useGadgetExports } from './useGadgetExports'
import { useBlueprintInfo, useGadgetSettings, useServices } from './useGadgetSettings'

export type GadgetSettingsPaneProps = {
  workspaceId: string
  workpieceId: number
  /** The title to show until the gadget's own arrives, e.g. from the gadget it was opened from. */
  initialTitle?: string
  tab: GadgetSettingsTab
  onTabChange: (tab: GadgetSettingsTab) => void
  /** Back to the gadget itself. */
  onBack: () => void
  /** It was deleted: go somewhere that still is. */
  onDeleted: () => void
  /** Goes to the page of the workspace it is in. */
  onOpenWorkspace?: () => void
  /** Names the browser's tab, as the page does. Left to whatever is beside, as the side pane's page is. */
  namesTab?: boolean
  /** The chat it is shown from, whose proposed changes an export of it includes. */
  chatId?: number
  /** An update from its template was proposed in this chat, which is where it is tried: go there. */
  onUpdateProposed: (chatId: number) => void
  /** Starts a chat beside it to connect it to something, by its title where it is known. Left out beside a chat, which is where to ask. */
  onConnect?: (title?: string) => void
  /** Goes to the page of an agent it starts, by its spawner's id. */
  onOpenAgent?: (spawnerId: number) => void
  agentHref?: (spawnerId: number) => string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A gadget's settings page (`GadgetSettingsView`) over what it shows: the gadget, live, what it is
 * bound to, the user's models its code can be given, its code as it was last kept, read once the Code tab is shown, and what its template
 * says of it, with whether it has a newer version to update it from (`UpdateFromTemplate`).
 */
export const GadgetSettingsPane = ({ workspaceId, workpieceId, initialTitle, tab, onTabChange, onBack, onDeleted, onOpenWorkspace, namesTab = true, chatId, onUpdateProposed, onConnect, onOpenAgent, agentHref }: GadgetSettingsPaneProps) => {
  const { settings, snapshot } = useGadgetSettings(workspaceId, workpieceId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  const services = useServices()
  const models = useBindableModels()
  const connection = useConnectionNotice()
  const devMode = useDevMode()
  const gadget = snapshot.status === 'ready' ? snapshot.gadget : undefined
  const title = gadget?.title ?? initialTitle
  const blueprintId = gadget?.upstream?.blueprintId
  const upstream = gadget?.upstream
  const blueprint = useBlueprintInfo(blueprintId, upstream?.commitId)
  // Only a gadget with code of its own takes an update, from a template it follows: one still
  // waiting in a chat has none, and one built from scratch follows none.
  const follows = upstream?.blueprintId !== undefined && gadget?.commitId !== undefined ? { ...upstream, blueprintId: upstream.blueprintId } : undefined
  const [updating, setUpdating] = useState(false)
  // Not there until it is first asked for, as it reads the templates.
  const [creating, setCreating] = useState<boolean>()
  const made = useMadeTemplates(workspaceId, creating === true || tab !== 'settings')
  const owner = useTemplateOwner(workspaceId, { onChange: made.refresh })
  const router = useRouter()
  // Only whoever builds in its workspace gets here, who may save it to their accounts too.
  const exports = useGadgetExports(gadget && { workspaceId, workpieceId, type: 'gadget', chatId }, title ?? '', { saves: true })
  useDocumentTitle(namesTab ? (title ? `Settings · ${title}` : 'App settings') : undefined)
  // Why the last thing asked for was not done.
  const [problem, setProblem] = useState<string>()
  // What its agents want of the user, as the workspace's Agents tab says it, by spawner.
  const { state: agentsState } = useWorkspaceAgents(workspaceId)
  const agentAttention = (spawnerId: number) => {
    const agent = agentsState.status === 'ready' ? agentByKey(agentsState.agents, agentKeyOf(spawnerId)) : undefined
    const words = agent && attentionWords(agent)
    return agent && words ? { words, tone: agent.waiting > 0 ? 'warning' as const : 'danger' as const } : undefined
  }

  // Asked for by the user: not tried over a lost connection, which says so itself.
  const attempt = (what: string, run: () => Promise<unknown>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${what}: ${messageOf(error)}`))
  }

  // Its settings, connections and code are its workspace's, which whoever it was shared with to
  // use does not build in. The server checks again.
  const state: GadgetSettingsState = workspace?.role === 'use' ? { status: 'shared' }
    : snapshot.status === 'failed' ? { status: 'failed', message: snapshot.message, onRetry: () => settings.restart() }
      : snapshot

  return (
    <>
      <GadgetSettingsView
        state={state.status === 'ready' ? { status: 'ready' } : state}
        title={title}
        icon={gadget?.output?.icon}
        description={blueprint?.description}
        // The template gone, there is nothing to update it from.
        templateUpdate={follows && blueprint !== null ? { status: templateUpdateStatus(follows, blueprint), onUpdate: () => setUpdating(true) } : undefined}
        template={gadget && { made: made.templates, onCreate: () => setCreating(true), onEdit: owner.edit, onRelease: owner.release, onDelete: owner.remove, busy: owner.busy, problem: owner.problem, onOpen: (id) => void router.navigate({ to: '/library/templates/$templateId', params: { templateId: id } }) }}
        exports={exports.menu}
        status={exports.status}
        workspace={workspace && { id: workspaceId, title: workspace.title, label: workspaceLabel(workspace.title), look }}
        tab={tab}
        onTabChange={onTabChange}
        onRename={gadget && ((next) => attempt('rename the gadget', () => settings.rename(next)))}
        problem={problem}
        bindings={snapshot.status === 'ready' ? snapshot.bindings : { status: 'loading' }}
        services={services}
        onConnect={onConnect && (() => onConnect(title))}
        onUnbind={(name) => attempt(`remove env.${name}`, () => settings.unbind(name))}
        // Said under the name, which keeps what was typed until it is put right.
        onRenameBinding={async (name, next) => {
          if (connection?.blocked()) return { saved: false }
          try {
            await settings.renameBinding(name, next)
            return { saved: true }
          } catch (error) {
            return { saved: false, problem: error instanceof InvalidBindingName ? error.message : `Couldn’t rename env.${name}: ${messageOf(error)}` }
          }
        }}
        models={models ?? {}}
        // Said in the dialog, which stays open under why. Over a lost connection nothing is tried.
        onChangeModel={async (name, modelId) => {
          if (connection?.blocked()) return false
          await settings.changeModel(name, modelId)
        }}
        onDelete={() => attempt('delete the gadget', async () => {
          await settings.remove()
          onDeleted()
        })}
        onBack={onBack}
        onOpenWorkspace={onOpenWorkspace}
        onOpenAgent={onOpenAgent}
        agentAttention={agentAttention}
        agentHref={agentHref}
        showsCodeNames={devMode}
        ids={devMode ? [
          { title: 'Gadget ID', value: String(workpieceId) },
          { title: 'Workspace ID', value: workspaceId },
          ...(chatId === undefined ? [] : [{ title: 'Chat ID', value: String(chatId) }]),
          ...(gadget?.commitId === undefined ? [] : [{ title: 'Commit', value: gadget.commitId }]),
          ...(blueprintId === undefined ? [] : [{ title: 'Template ID', value: blueprintId }]),
        ] : undefined}
      />
      {exports.dialogs}
      {gadget && creating !== undefined && (
        <CreateTemplate gadget={{ workspaceId, workpieceId, title: title ?? '' }} open={creating} onOpenChange={setCreating} />
      )}
      {follows && (
        <UpdateFromTemplate
          open={updating}
          onOpenChange={setUpdating}
          workspaceId={workspaceId}
          gadgetId={workpieceId}
          title={title ?? ''}
          upstream={follows}
          template={blueprint}
          onProposed={onUpdateProposed}
        />
      )}
    </>
  )
}
