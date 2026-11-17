import { CaretLeftIcon, ShareNetworkIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { BindingRow } from '@/blocks/BindingRow'
import { ListGroup } from '@/blocks/ListGroup'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { WorkspaceLook } from '@/components/workspaceLook'
import { PageLayout } from '@/layouts/PageLayout'
import { groupBindings, type GadgetBinding, type Listed } from './GadgetSettings'
import type { BindingService } from './useGadgetSettings'

/** What a gadget's settings page shows beneath its name. */
export type GadgetSettingsTab = 'connections' | 'settings'

export const GADGET_SETTINGS_TABS: { value: GadgetSettingsTab; label: string }[] = [
  { value: 'connections', label: 'Connections' },
  { value: 'settings', label: 'Settings' },
]

/** How far the gadget has got, as the page shows it. */
export type GadgetSettingsState =
  | { status: 'loading' }
  | { status: 'ready' }
  /** The viewer has no access to its workspace. */
  | { status: 'denied' }
  /** There is no such gadget, or it was deleted. */
  | { status: 'gone' }
  | { status: 'failed'; message: string; onRetry: () => void }
  /** It was shared with the viewer to use, which leaves nothing here for them to change. */
  | { status: 'shared' }

export type GadgetSettingsViewProps = {
  state: GadgetSettingsState
  /** Its title, or what it was called where it was opened from until its own arrives. */
  title?: string
  /** What it is drawn as, from what it was made as. */
  icon?: FormatIconName
  /** What its template says it is for. */
  description?: string
  /** The template it was made from, by its title; `null` where it was built from scratch. */
  template?: string | null
  /** The workspace it is in, which the header's crumb goes to. */
  workspace?: { id: string; title: string; label: string; look?: WorkspaceLook }
  tab: GadgetSettingsTab
  onTabChange: (tab: GadgetSettingsTab) => void
  /** Renames it. Left out until there is a gadget to rename. */
  onRename?: (title: string) => void
  /** What was asked for last and could not be done, and why. */
  problem?: string
  bindings: Listed<GadgetBinding>
  /** The services it can be bound through, by id, for their names and logos. */
  services: ReadonlyMap<string, BindingService>
  /** Takes a binding away from it, by the name its code knows it by. */
  onUnbind: (name: string) => void
  /** Deletes it, for everyone it is shared with, asked for twice. */
  onDelete: () => void
  /** Back to the gadget itself. */
  onBack: () => void
  /** Goes to the page of the workspace it is in. */
  onOpenWorkspace: () => void
}

const Message = ({ children }: { children: string }) => <p className="appears px-5 text-base text-kumo-subtle">{children}</p>

/**
 * A gadget's settings page, laid out as a skill's is: what it is drawn as, its title, renamed
 * where it is, and what its template says it is for, then a tab each (`?tab=`): what it is
 * connected to, with the agents it can start apart, and its
 * settings, which are where it is from and deleting it. Only whoever may build in its workspace
 * gets here: anyone it was shared with to use is told that its settings are not theirs.
 */
export const GadgetSettingsView = ({
  state, title, icon, description, template, workspace, tab, onTabChange, onRename, problem, bindings, services, onUnbind, onDelete, onBack, onOpenWorkspace,
}: GadgetSettingsViewProps) => {
  const header = (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
      {workspace && <WorkspaceCrumb id={workspace.id} title={workspace.title} label={workspace.label} look={workspace.look} onOpen={onOpenWorkspace} />}
      <HeaderBubble>
        <Button icon={CaretLeftIcon} onClick={onBack}>Back to gadget</Button>
      </HeaderBubble>
    </nav>
  )

  if (state.status === 'denied' || state.status === 'gone' || state.status === 'failed' || state.status === 'shared') {
    return (
      <PageLayout header={header}>
        <div className="flex min-h-[60vh] flex-col">
          {state.status === 'denied' ? (
            <PaneNotice icon={WarningCircleIcon} title={`You don’t have access to ${title || 'this gadget'}`} description="Ask whoever shared it to add you to its workspace." />
          ) : state.status === 'gone' ? (
            <PaneNotice icon={WarningCircleIcon} title="This gadget isn’t here" description="It may have been deleted, or the link is wrong." />
          ) : state.status === 'failed' ? (
            <PaneNotice icon={WarningCircleIcon} title="Couldn’t load the gadget" description={state.message} action={{ label: 'Try again', onClick: state.onRetry }} />
          ) : (
            <PaneNotice
              icon={ShareNetworkIcon}
              title={`${title || 'This gadget'} was shared with you`}
              description="Its settings are for whoever builds in its workspace."
              action={{ label: 'Back to gadget', onClick: onBack }}
            />
          )}
        </div>
      </PageLayout>
    )
  }

  const { connections, agents } = groupBindings(bindings.status === 'ready' ? bindings.items : [])
  const row = (binding: GadgetBinding) => (
    <BindingRow
      key={binding.name}
      title={binding.resourceTitle || binding.name}
      name={binding.name}
      service={binding.vendorId === undefined ? undefined : services.get(binding.vendorId)}
      kind={binding.kind === 'service' ? undefined : binding.kind}
      model={binding.model}
      pending={binding.chatId !== undefined}
      onRemove={() => onUnbind(binding.name)}
    />
  )

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-1 pt-8 text-center">
          {/* What it is, as it is drawn wherever it is listed. */}
          <span className="mb-1 grid size-11 place-items-center rounded-2xl bg-kumo-tint text-kumo-default">
            <FormatIcon name={icon} className="size-5.5" />
          </span>
          {/* Its own heading, which can be renamed once the gadget is there to rename. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {onRename
              ? <EditableTitle value={title ?? ''} onRename={onRename} aria-label="Gadget title" placeholder="Untitled gadget" className="text-center" />
              : <span className="px-2.5 py-1">{title || 'Gadget'}</span>}
          </h1>
          {/* Its template's to say, so it is read here and not changed. */}
          {description && <p className="appears max-w-prose px-2.5 py-1 text-base text-pretty text-kumo-subtle">{description}</p>}
          {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
        </div>
        {state.status === 'loading' && <p role="status" className="appears-late px-5 text-center text-base text-kumo-subtle">Loading the gadget…</p>}
        {state.status === 'ready' && (
          <Tabs value={tab} onValueChange={onTabChange} tabs={GADGET_SETTINGS_TABS} aria-label="Gadget" className="gap-6">
            <Tabs.Panel value="connections" className="flex flex-col gap-12">
              <SettingsGroup title="Connected to" description="What its code can reach, by the name it knows each by." plain>
                {bindings.status === 'loading' && <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading its connections…</p>}
                {bindings.status === 'failed' && <Message>{`Couldn’t load its connections: ${bindings.message}`}</Message>}
                {bindings.status === 'ready' && (connections.length === 0
                  ? <Message>Nothing yet. Ask the agent in a chat to connect it to a service.</Message>
                  : (
                      <ListGroup label="Connected to">
                        <ul className="flex flex-col">{connections.map(row)}</ul>
                      </ListGroup>
                    ))}
              </SettingsGroup>
              {/* Only once it has any: most gadgets start none. */}
              {agents.length > 0 && (
                <SettingsGroup title="Agents" description="Agents its code can start, each with a conversation of its own." plain>
                  <ListGroup label="Agents">
                    <ul className="flex flex-col">{agents.map(row)}</ul>
                  </ListGroup>
                </SettingsGroup>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="settings" className="flex flex-col gap-12">
              <SettingsGroup title="Gadget details">
                {workspace && (
                  <SettingRow title="Workspace" description="Where it was made. Everyone who builds there can change it.">
                    <span className="flex min-w-0 items-center gap-2 text-kumo-default">
                      <WorkspaceIcon label={workspace.label} {...workspace.look} small />
                      <span className="truncate">{workspace.title}</span>
                    </span>
                  </SettingRow>
                )}
                {template !== undefined && (
                  <SettingRow
                    title="Template"
                    description={template === null ? 'It was built from scratch, not from a template.' : 'What it was made from, which it can take updates from.'}
                  >
                    {template === null ? undefined : <span className="truncate text-kumo-default">{template}</span>}
                  </SettingRow>
                )}
              </SettingsGroup>
              <SettingsGroup title="Danger zone">
                <SettingRow title="Delete this gadget" description="It goes for everyone it’s shared with. What it’s connected to stays in the workspace.">
                  <ConfirmMenu
                    label="Delete gadget"
                    title={`Delete “${title || 'this gadget'}”?`}
                    description="It goes for everyone it’s shared with, with anything set to run it. This can’t be undone."
                    confirmLabel="Delete"
                    onConfirm={onDelete}
                  />
                </SettingRow>
              </SettingsGroup>
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
    </PageLayout>
  )
}
