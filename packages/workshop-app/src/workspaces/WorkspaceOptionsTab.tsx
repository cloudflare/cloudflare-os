import { useState } from 'react'
import { REMOVAL_WORDS } from '@/blocks/RemoveWorkspaceDialog'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard } from '@/blocks/SettingsGroup'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { messageOf } from '@/settings/useAttempt'

export type WorkspaceOptionsTabProps = {
  /** The workspace's title, as it is shown, which removing it asks about. */
  title: string
  /** Marks every chat in the workspace read. Left out while nothing in it is unread, which is said in its place. */
  onMarkRead?: () => Promise<void>
  /**
   * How the viewer may take the workspace out of their list, and the way to do it, once asked.
   * `others` is how many besides the viewer have access to it, once known. Left out where the viewer may not.
   */
  removal?: { kind: WorkspaceRemoval; others?: number; onConfirm: () => Promise<void> }
}

const ROW: Record<WorkspaceRemoval, { title: string; description: string; label: string }> = {
  delete: {
    title: 'Delete workspace',
    description: 'Its chats, everything made in it and anything set to run there are deleted for everyone it’s shared with. This can’t be undone.',
    label: 'Delete',
  },
  dismiss: {
    title: 'Remove from my list',
    description: 'It stays as it is for everyone else, and you keep your access: open it again from its link and it’s back in your list.',
    label: 'Remove',
  },
}

/**
 * What the viewer can do about a workspace, as a tab of its page: marking everything in it read,
 * while anything is unread, and deleting it, as its owner, or removing it from their list, as
 * someone it was shared with, which asks first.
 */
export const WorkspaceOptionsTab = ({ title, onMarkRead, removal }: WorkspaceOptionsTabProps) => {
  const connection = useConnectionNotice()
  // Why the last change was not made.
  const [problem, setProblem] = useState<string>()

  const attempt = (what: string, action: () => Promise<void>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    action().catch((error: unknown) => setProblem(`Couldn’t ${what}: ${messageOf(error)}`))
  }

  return (
    <>
      {problem && <p role="alert" className="px-4 text-base text-kumo-danger">{problem}</p>}
      <SettingsCard>
        <SettingRow title="Mark all as read" description="Marks every chat in the workspace as read.">
          {onMarkRead
            ? <Button onClick={() => attempt('mark the workspace read', onMarkRead)}>Mark all as read</Button>
            : <span className="inline-flex h-(--control-size) items-center px-(--control-pad) text-(length:--control-text) font-medium text-kumo-subtle">All read</span>}
        </SettingRow>
        {removal && (
          <SettingRow title={ROW[removal.kind].title} description={ROW[removal.kind].description}>
            <ConfirmMenu
              label={ROW[removal.kind].label}
              title={REMOVAL_WORDS[removal.kind].question(title || 'Untitled workspace')}
              description={REMOVAL_WORDS[removal.kind].said(removal.others)}
              confirmLabel={REMOVAL_WORDS[removal.kind].confirm}
              triggerVariant={removal.kind === 'delete' ? 'danger' : 'secondary'}
              onConfirm={() => attempt(removal.kind === 'delete' ? 'delete the workspace' : 'remove the workspace', removal.onConfirm)}
            />
          </SettingRow>
        )}
      </SettingsCard>
    </>
  )
}
