import { useState } from 'react'
import { CaretLeftIcon, ExportIcon, TrashIcon, UserCircleGearIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { BindingRow } from '@/blocks/BindingRow'
import { GadgetNoAccess } from '@/blocks/GadgetNoAccess'
import { HookCard } from '@/blocks/HookCard'
import { ListGroup } from '@/blocks/ListGroup'
import { PaneNotice } from '@/blocks/PaneNotice'
import { PublishBlueprintDialog } from '@/blocks/PublishBlueprintDialog'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EditableTitle } from '@/components/EditableTitle'
import { FormatIcon } from '@/components/FormatIcon'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { useServices } from '@/connections/useServices'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { Listed } from './GadgetSettings'
import { useBlueprintDescription, useGadgetSettings } from './useGadgetSettings'

export const GADGET_SETTINGS_TABS = [
  { value: 'settings', label: 'Settings' },
  { value: 'connections', label: 'Connections' },
] as const

export type GadgetSettingsTab = (typeof GADGET_SETTINGS_TABS)[number]['value']

export type GadgetSettingsPaneProps = {
  workspaceId: string
  workpieceId: number
  /** The title to show until the gadget's own arrives, e.g. from the page it was opened from. */
  initialTitle?: string
  tab: GadgetSettingsTab
  onTabChange: (tab: GadgetSettingsTab) => void
  onBack: () => void
  /** Who has the gadget, and who can change it: where that is managed, as its share dialog. */
  onManageAccess?: () => void
  /** It was deleted: go somewhere that still is. */
  onDeleted: () => void
  /** Where the accounts its connections go through are managed. */
  onOpenConnections: () => void
  /** Its own address, for whoever has no access to ask for it with. */
  link: string
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const ListState = ({ list, what }: { list: Listed<unknown>; what: string }) =>
  list.status === 'loading' ? <p role="status" className="appears-late px-4 text-base text-kumo-subtle">Loading {what}…</p>
    : list.status === 'failed' ? <p className="px-4 text-base text-kumo-subtle">Couldn’t load {what}: {list.message}</p>
      : null

/**
 * A gadget's own settings (from its More, or full screen), laid out as a chat's are: back to it,
 * what kind it is, its title, renamed in place by whoever may build in its workspace, and what its
 * blueprint says it is for. Then tabs (`?tab=`): who has it, publishing it as a blueprint and
 * deleting it; and what it is connected to, with the automations that run it.
 */
export const GadgetSettingsPane = ({
  workspaceId, workpieceId, initialTitle, tab, onTabChange, onBack, onManageAccess, onDeleted, onOpenConnections, link,
}: GadgetSettingsPaneProps) => {
  const { settings, snapshot } = useGadgetSettings(workspaceId, workpieceId)
  const workspaces = useWorkspaces()
  const workspace = workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === workspaceId) : undefined
  // Only whoever may build in the workspace changes what is in it; the server checks again.
  const builds = workspace !== undefined && workspace.role !== 'use'
  const { services } = useServices()
  const connection = useConnectionNotice()
  const gadget = snapshot.status === 'ready' ? snapshot.gadget : undefined
  const title = gadget?.title ?? initialTitle
  const description = useBlueprintDescription(gadget?.upstream?.blueprintId)
  useDocumentTitle(title ? `Settings · ${title}` : 'Gadget settings')

  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const rename = (next: string) => {
    setRenameProblem(undefined)
    if (connection?.blocked()) return
    settings.rename(next).catch((error: unknown) => setRenameProblem(`Couldn’t rename the gadget: ${messageOf(error)}`))
  }
  const serviceOf = (vendorId: string | undefined) => {
    const vendor = vendorId === undefined || services.status !== 'ready' ? undefined : services.vendors.find(({ id }) => id === vendorId)
    return vendor && { name: vendor.description.displayName, logoUrl: vendor.description.logo?.url, color: vendor.description.color }
  }

  const header = (
    <HeaderBubble>
      <Button icon={CaretLeftIcon} onClick={onBack}>Back to gadget</Button>
    </HeaderBubble>
  )

  if (snapshot.status === 'denied') {
    return (
      <PageLayout header={header}>
        <GadgetNoAccess title={title ?? 'this gadget'} link={link} />
      </PageLayout>
    )
  }
  if (snapshot.status === 'gone' || snapshot.status === 'failed') {
    return (
      <PageLayout header={header}>
        <div className="flex min-h-[60vh] flex-col">
          {snapshot.status === 'gone'
            ? <PaneNotice icon={WarningCircleIcon} title="This gadget isn’t here" description="It may have been deleted, or the link is wrong." />
            : <PaneNotice icon={WarningCircleIcon} title="Couldn’t load the gadget" description={snapshot.message} action={{ label: 'Try again', onClick: () => settings.restart() }} />}
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-kumo-tint text-kumo-default [&>svg]:size-[1.125em]">
            <FormatIcon name={gadget?.output?.icon} />
          </span>
          {/* Its own heading, which can be renamed by whoever may build in its workspace. */}
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {gadget && builds
              ? <EditableTitle value={gadget.title} onRename={rename} aria-label="Gadget title" placeholder="Untitled gadget" className="text-center" />
              : <span className="px-2.5 py-1">{title || 'Gadget'}</span>}
          </h1>
          {renameProblem && <p role="alert" className="text-base text-kumo-subtle">{renameProblem}</p>}
          {description && <p className="appears max-w-sm text-base/5 text-kumo-subtle">{description}</p>}
        </div>
        {snapshot.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the gadget…</p>}
        {snapshot.status === 'ready' && (
          <Tabs value={tab} onValueChange={onTabChange} tabs={[...GADGET_SETTINGS_TABS]} aria-label="Gadget settings" className="gap-6">
            <Tabs.Panel value="settings" className="flex flex-col gap-2">
              <SettingsGroup label="Gadget">
                {onManageAccess && (
                  <SettingsRow
                    title="Access"
                    description="Choose who can use this gadget, and who can change it."
                    control={<Button icon={UserCircleGearIcon} onClick={onManageAccess}>Manage</Button>}
                  />
                )}
                {builds && (
                  <SettingsRow
                    title="Publish as blueprint"
                    description="Let others start their own gadget from this one."
                    control={<Button icon={ExportIcon} onClick={() => setPublishing(true)}>Publish</Button>}
                  />
                )}
              </SettingsGroup>
              {builds && (
                <SettingsGroup label="Danger">
                  <SettingsRow
                    danger
                    title="Delete gadget"
                    description={<>Delete it for everyone it’s shared with, so it can’t be opened anymore. <span className="text-kumo-default">This can’t be undone.</span></>}
                    control={<Button variant="danger" icon={TrashIcon} onClick={() => setDeleting(true)}>Delete</Button>}
                  />
                </SettingsGroup>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="connections" className="flex flex-col gap-8">
              <section className="flex flex-col gap-2">
                <h2 className="px-4 text-sm font-medium text-kumo-subtle">Connected to</h2>
                <ListState list={snapshot.bindings} what="its connections" />
                {snapshot.bindings.status === 'ready' && (snapshot.bindings.items.length === 0 ? (
                  <p className="px-4 text-base text-kumo-subtle">Nothing yet. When the agent connects it to a service, it shows here.</p>
                ) : (
                  <ListGroup label="Connected to">
                    {snapshot.bindings.items.map((binding) => (
                      <BindingRow
                        key={binding.name}
                        name={binding.name}
                        resource={binding.resourceTitle}
                        service={serviceOf(binding.vendorId)}
                        pending={binding.chatId !== undefined}
                        onManage={onOpenConnections}
                        onRemove={builds ? async () => {
                          if (connection?.blocked()) return false
                          await settings.unbind(binding.name)
                          return true
                        } : undefined}
                      />
                    ))}
                  </ListGroup>
                ))}
              </section>
              <section className="flex flex-col gap-2">
                <h2 className="px-4 text-sm font-medium text-kumo-subtle">Automations</h2>
                <ListState list={snapshot.hooks} what="its automations" />
                {snapshot.hooks.status === 'ready' && (snapshot.hooks.items.length === 0 ? (
                  <p className="px-4 text-base text-kumo-subtle">None yet. What the agent sets up to run it when something happens shows here.</p>
                ) : snapshot.hooks.items.map((hook) => (
                  <HookCard
                    key={hook.id}
                    title={hook.description.title}
                    description={hook.description.description}
                    resource={hook.resourceTitle ? { title: hook.resourceTitle, url: hook.resourceUrl } : undefined}
                    enabled={hook.enabled}
                    onEnabledChange={builds ? async (enabled) => {
                      if (connection?.blocked()) return
                      await settings.setHookEnabled(hook.id, enabled)
                    } : undefined}
                  />
                )))}
              </section>
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
      {gadget && (
        <PublishBlueprintDialog
          open={publishing}
          onOpenChange={setPublishing}
          initialTitle={gadget.title}
          initialDescription={description}
          onPublish={async (nextTitle, nextDescription) => {
            if (connection?.blocked()) return false
            await settings.publish(nextTitle, nextDescription)
            return true
          }}
        />
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete “${title || 'this gadget'}”?`}
        description="It goes for everyone it’s shared with, with its automations. What it’s connected to stays in the workspace. This can’t be undone."
        confirm="Delete gadget"
        onConfirm={async () => {
          if (connection?.blocked()) return false
          await settings.remove()
          onDeleted()
          return true
        }}
      />
    </PageLayout>
  )
}
