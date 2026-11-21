import { PlusIcon, XIcon } from '@phosphor-icons/react'
import { Button, CardAction, DropdownMenu, LIST_ACTION, OptionPicker, SettingsGroup } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'

/** A workspace as it is listed and offered here. */
export type MutableWorkspace = {
  id: string
  title: string
  /** Two letters shown on the icon. */
  label: string
  /** How its icon is drawn, when not as any workspace's is. */
  look?: WorkspaceLook
}

export type MutedWorkspacesProps = {
  title: string
  /** What muting one does, in a line under the title. */
  description?: string
  /** The muted ones, each with when it ends, where it does by itself: "Until Nov 18, 9:00 AM". */
  muted: (MutableWorkspace & { until?: string })[]
  /** The ones that could be muted, in the order they are offered. With none, there is no way to. */
  others: MutableWorkspace[]
  /** The workspaces are not known yet. */
  loading?: boolean
  /** Why they could not be read, which is said in place of them. */
  failure?: string
  /** What was asked for and could not be done, over the list. */
  problem?: string
  onMute: (id: string) => void
  onUnmute: (id: string) => void
}

const icon = ({ label, look }: MutableWorkspace) => <WorkspaceIcon label={label} {...look} small />

/**
 * The workspaces that are kept quiet, as a `SettingsGroup`: the way to mute another is across from
 * its title, a button that opens in place to those that could be, under a field to find one by,
 * and choosing one mutes it. Each one muted is unmuted from its line.
 */
export const MutedWorkspaces = ({ title, description, muted, others, loading = false, failure, problem, onMute, onUnmute }: MutedWorkspacesProps) => {
  return (
    <SettingsGroup
      title={title}
      description={description}
      action={others.length > 0 && (
        <DropdownMenu icon={PlusIcon} label="Mute workspace" picker inPlace align="end">
          {(close) => (
            <OptionPicker
              single
              aria-label="Workspace to mute"
              options={others.map((workspace) => ({ id: workspace.id, label: workspace.title, icon: icon(workspace) }))}
              // None of them: they are all still to be chosen.
              value=""
              onValueChange={(id) => {
                onMute(id)
                close()
              }}
            />
          )}
        </DropdownMenu>
      )}
    >
      {problem && <p role="alert" className="py-4 text-sm text-kumo-danger">{problem}</p>}
      {loading && <p role="status" className="appears-late py-4 text-kumo-subtle">Loading workspaces…</p>}
      {failure !== undefined && <p className="py-4 text-kumo-subtle">Couldn’t load workspaces: {failure}</p>}
      {!loading && failure === undefined && muted.length === 0 && <p className="py-4 text-kumo-subtle">No muted workspaces.</p>}
      {muted.length > 0 && (
        <ul aria-label={title} className="flex flex-col">
          {muted.map((workspace) => (
            <li key={workspace.id} className="group flex items-center gap-3 border-t border-kumo-line py-3 first:border-t-0">
              {icon(workspace)}
              <span className="flex min-w-0 flex-1 flex-col leading-snug">
                <span className="truncate font-medium text-kumo-default">{workspace.title}</span>
                {workspace.until && <span className="truncate text-sm text-kumo-subtle">{workspace.until}</span>}
              </span>
              {/* Seen while the workspace is pointed at or has the focus, and always to a finger. */}
              <CardAction>
                <Button variant="ghost" icon={XIcon} aria-label={`Unmute ${workspace.title}`} title="Unmute" onClick={() => onUnmute(workspace.id)} className={LIST_ACTION} />
              </CardAction>
            </li>
          ))}
        </ul>
      )}
    </SettingsGroup>
  )
}
