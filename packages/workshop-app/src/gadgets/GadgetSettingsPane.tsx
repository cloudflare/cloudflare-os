import { useState } from 'react'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { useWorkspaceLooks } from '@/workspaces/useWorkspaceLooks'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { GadgetSettingsView, type GadgetSettingsState, type GadgetSettingsTab } from './GadgetSettingsView'
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
  onOpenWorkspace: () => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * A gadget's settings page (`GadgetSettingsView`) over what it shows: the gadget, live, what it is
 * bound to, its code as it was last kept, read once the Code tab is shown, and what its template
 * says of it.
 */
export const GadgetSettingsPane = ({ workspaceId, workpieceId, initialTitle, tab, onTabChange, onBack, onDeleted, onOpenWorkspace }: GadgetSettingsPaneProps) => {
  const { settings, snapshot } = useGadgetSettings(workspaceId, workpieceId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  const look = useWorkspaceLooks()[workspaceId]
  const services = useServices()
  const connection = useConnectionNotice()
  const gadget = snapshot.status === 'ready' ? snapshot.gadget : undefined
  const title = gadget?.title ?? initialTitle
  const blueprintId = gadget?.upstream?.blueprintId
  const blueprint = useBlueprintInfo(blueprintId)
  useDocumentTitle(title ? `Settings · ${title}` : 'Gadget settings')
  // Why the last thing asked for was not done.
  const [problem, setProblem] = useState<string>()

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
    <GadgetSettingsView
      state={state.status === 'ready' ? { status: 'ready' } : state}
      title={title}
      icon={gadget?.output?.icon}
      description={blueprint?.description}
      // Where it came from is known only for a gadget that says; one built from scratch names no template.
      template={gadget?.upstream ? (blueprintId ? blueprint?.title : null) : undefined}
      workspace={workspace && { id: workspaceId, title: workspace.title, label: workspaceLabel(workspace.title), look }}
      tab={tab}
      onTabChange={onTabChange}
      onRename={gadget && ((next) => attempt('rename the gadget', () => settings.rename(next)))}
      problem={problem}
      bindings={snapshot.status === 'ready' ? snapshot.bindings : { status: 'loading' }}
      services={services}
      onUnbind={(name) => attempt(`remove env.${name}`, () => settings.unbind(name))}
      onDelete={() => attempt('delete the gadget', async () => {
        await settings.remove()
        onDeleted()
      })}
      onBack={onBack}
      onOpenWorkspace={onOpenWorkspace}
    />
  )
}
