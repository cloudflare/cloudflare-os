import { AppWindowIcon, LockSimpleIcon } from '@phosphor-icons/react'
import type { OutputSummary, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { DropdownMenu } from '@/components/DropdownMenu'
import { EmptyState, type EmptyStateAction } from '@/components/EmptyState'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useLibrary } from '@/library/useLibrary'
import { workspaceLabel } from './workspaceLabel'
import { useWorkspaceLooks } from './useWorkspaceLooks'

export type SharedAppPaneProps = {
  /** The workspace, as listed, which the viewer can only use an app of (`role === 'use'`). */
  workspace: WorkspaceMetadataWithTimestamps
  /** Opens one of the apps shared with the viewer, on its own page. */
  onOpenOutput: (output: OutputSummary) => void
  onOpenLibrary: () => void
}

/**
 * A workspace's page for someone it was not shared with, who was only shared an app of it to use:
 * that it is not theirs to open, in its place beside the sidebar, and the way to what was shared
 * with them, which their Library has (`useLibrary`): the app, or a menu of them where there are
 * several, else the Library itself. Nothing of the workspace is read, as what it has is a member's.
 */
export const SharedAppPane = ({ workspace, onOpenOutput, onOpenLibrary }: SharedAppPaneProps) => {
  const title = workspace.title || 'Workspace'
  useDocumentTitle(title)
  const look = useWorkspaceLooks()[workspace.id]
  const library = useLibrary()
  const apps = library.status === 'ready' ? library.outputs.filter(({ workspaceId }) => workspaceId === workspace.id) : []
  const action: EmptyStateAction = apps.length === 1
    ? { label: `Open ${apps[0].title || 'app'}`, icon: AppWindowIcon, variant: 'primary', onClick: () => onOpenOutput(apps[0]) }
    : apps.length > 1
      ? {
          label: 'Open an app',
          icon: AppWindowIcon,
          variant: 'primary',
          menu: apps.map((app) => (
            <DropdownMenu.Item key={app.workpieceId} icon={AppWindowIcon} onSelect={() => onOpenOutput(app)}>{app.title || 'Untitled app'}</DropdownMenu.Item>
          )),
        }
      : { label: 'Go to Library', variant: 'primary', onClick: onOpenLibrary }
  const who = workspace.owner?.name ?? 'Someone'

  return (
    <PageLayout
      fill
      header={(
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          <WorkspaceCrumb id={workspace.id} title={workspace.title} label={workspaceLabel(workspace.title)} look={look} expanded />
        </nav>
      )}
    >
      <EmptyState
        icon={LockSimpleIcon}
        title="You’re not a member of this workspace"
        description={`${who} shared ${apps.length > 1 ? 'some apps' : 'an app'} from ${title} with you to use, not the workspace itself. ${apps.length > 1 ? 'They’re' : 'It’s'} in your Library.`}
        actions={[action]}
      />
    </PageLayout>
  )
}
