import { useMemo, useState } from 'react'
import { CaretLeftIcon, ExportIcon, PlusIcon, ShapesIcon, TrashIcon, UserCircleGearIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { ofGadget } from '@/automations/automations'
import { AutomationsTab, type AutomationLink } from '@/automations/AutomationsTab'
import { BindingRow } from '@/blocks/BindingRow'
import { CodeBrowser } from '@/blocks/CodeBrowser'
import { GadgetKindDialog } from '@/blocks/GadgetKindDialog'
import { GadgetNoAccess } from '@/blocks/GadgetNoAccess'
import { ListGroup } from '@/blocks/ListGroup'
import { GadgetExportRow } from './GadgetExportRow'
import { PaneNotice } from '@/blocks/PaneNotice'
import { PublishBlueprintDialog } from '@/blocks/PublishBlueprintDialog'
import { SettingsGroup, SettingsRow } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EditableTitle } from '@/components/EditableTitle'
import { FormatIcon } from '@/components/FormatIcon'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Tabs } from '@/components/Tabs'
import { AddConnection } from '@/connections/AddConnection'
import { useServices } from '@/connections/useServices'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { ShareGadgetDialog } from '@/sharing/ShareGadgetDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import type { Listed } from './GadgetSettings'
import { useBlueprintDescription, useGadgetSettings } from './useGadgetSettings'
import { useGadgetCode } from './useGadgetCode'
import { usePublishPicture } from './usePublishPicture'

export const GADGET_SETTINGS_TABS = [
  { value: 'settings', label: 'Settings' },
  { value: 'connections', label: 'Connections' },
  { value: 'automations', label: 'Automations' },
  { value: 'code', label: 'Code' },
] as const

export type GadgetSettingsTab = (typeof GADGET_SETTINGS_TABS)[number]['value']

export type GadgetSettingsPaneProps = {
  workspaceId: string
  workpieceId: number
  /** The title to show until the gadget's own arrives, e.g. from the page it was opened from. */
  initialTitle?: string
  tab: GadgetSettingsTab
  onTabChange: (tab: GadgetSettingsTab) => void
  /** On the Code tab, the path of the file to show; none, the first. */
  file?: string
  onShowFile: (path: string) => void
  onBack: () => void
  /** It was deleted: go somewhere that still is. */
  onDeleted: () => void
  /** Where the accounts its connections go through are managed. */
  onOpenConnections: () => void
  /** Its own address: what its share link lets people in to, and what whoever has no access asks for. */
  link: string
  /** Where an automation reports, for its row to open and link to. */
  automationLink: AutomationLink
  /** Opens the page of a blueprint it was just published as. */
  onOpenBlueprint?: (blueprintId: string) => void
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
 * deleting it; what it is connected to; and the automations that run its code.
 */
export const GadgetSettingsPane = ({
  workspaceId, workpieceId, initialTitle, tab, onTabChange, file, onShowFile, onBack, onDeleted, onOpenConnections, link, automationLink, onOpenBlueprint,
}: GadgetSettingsPaneProps) => {
  const own = useMemo(() => ofGadget(workpieceId), [workpieceId])
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
  useDocumentTitle(title ? `${tab === 'code' ? 'Code' : 'Settings'} · ${title}` : 'Gadget settings')
  // Its code is for whoever builds in its workspace, as changing it is; anyone else is shown its
  // settings. Until the workspaces are read, a link to its code is taken at its word.
  const readsCode = workspaces.status === 'ready' ? builds : tab === 'code'
  const tabs = GADGET_SETTINGS_TABS.filter(({ value }) => value !== 'code' || readsCode)
  const shownTab = tab === 'code' && !readsCode ? 'settings' : tab
  const code = useGadgetCode(workspaceId, gadget?.commitId, file, shownTab === 'code')

  // Why the last new title was not kept.
  const [renameProblem, setRenameProblem] = useState<string>()
  const [publishing, setPublishing] = useState(false)
  // Drawn as publishing opens, to go with it.
  const publishPicture = usePublishPicture(settings, publishing)
  // The blueprint it was last published as, for its page to be opened.
  const [published, setPublished] = useState<string>()
  const [sharing, setSharing] = useState(false)
  const [choosingKind, setChoosingKind] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [addingConnection, setAddingConnection] = useState(false)

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
          <Tabs value={shownTab} onValueChange={onTabChange} tabs={tabs} aria-label="Gadget settings" className="gap-6">
            <Tabs.Panel value="settings" className="flex flex-col gap-2">
              <SettingsGroup label="Gadget">
                {builds && (
                  <SettingsRow
                    title="What it is"
                    description={gadget?.output
                      ? `A ${gadget.output.noun.toLowerCase()}, wherever it’s listed and in blueprints made from it.`
                      : 'Give it a kind and an icon, shown wherever it’s listed and in blueprints made from it.'}
                    control={<Button icon={gadget?.output ? <FormatIcon name={gadget.output.icon} /> : ShapesIcon} onClick={() => setChoosingKind(true)}>{gadget?.output?.noun ?? 'Choose'}</Button>}
                  />
                )}
                {builds && (
                  <SettingsRow
                    title="Access"
                    description="Choose who can use this gadget, and who can change it."
                    control={<Button icon={UserCircleGearIcon} onClick={() => setSharing(true)}>Manage</Button>}
                  />
                )}
                {builds && (
                  <SettingsRow
                    title="Publish as blueprint"
                    description="Let others start their own gadget from this one."
                    control={<Button icon={ExportIcon} onClick={() => setPublishing(true)}>Publish</Button>}
                  />
                )}
                <GadgetExportRow workspaceId={workspaceId} workpieceId={workpieceId} title={title ?? ''} />
              </SettingsGroup>
              {builds && (
                <SettingsGroup label="Danger">
                  <SettingsRow
                    danger
                    title="Delete gadget"
                    description="Deletes it for everyone it’s shared with, with its automations."
                    control={<Button variant="danger" icon={TrashIcon} onClick={() => setDeleting(true)}>Delete</Button>}
                  />
                </SettingsGroup>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="connections" className="flex flex-col gap-8">
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3 ps-4">
                  <h2 className="text-sm font-medium text-kumo-subtle">Connected to</h2>
                  {builds && (
                    <Button variant="ghost" icon={PlusIcon} onClick={() => {
                      if (!connection?.blocked()) setAddingConnection(true)
                    }}>Add</Button>
                  )}
                </div>
                <ListState list={snapshot.bindings} what="its connections" />
                {snapshot.bindings.status === 'ready' && (snapshot.bindings.items.length === 0 ? (
                  <p className="px-4 text-base text-kumo-subtle">Nothing yet. Add a connection, or ask the agent to connect it to a service.</p>
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
            </Tabs.Panel>
            {readsCode && (
              // Wider than the settings, as code is: a line of it reads whole.
              <Tabs.Panel value="code" className="flex flex-col gap-3 lg:-mx-24">
                <CodeBrowser files={code.files} shown={code.shown} onShow={onShowFile} file={code.file} onRetry={code.retry} empty="It has no code yet. Once a chat writes some and it’s kept, it shows here." />
                <p className="px-4 text-sm/5 text-kumo-subtle">
                  The code as it was last kept. To change it, ask in a chat: what the agent writes shows here once it’s kept.
                </p>
              </Tabs.Panel>
            )}
            <Tabs.Panel value="automations" className="flex flex-col gap-8">
              {tab === 'automations' && (
                <AutomationsTab
                  workspaceIds={[workspaceId]}
                  filter={own}
                  canChange={() => builds}
                  link={automationLink}
                  empty="Nothing runs this gadget by itself yet. Ask in a chat for it to run on a schedule, or when something arrives."
                />
              )}
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
      {builds && gadget && (
        <GadgetKindDialog
          // Starting from what it is now, as the agent may have changed it since.
          key={`${gadget.output?.noun}\n${gadget.output?.icon}`}
          open={choosingKind}
          onOpenChange={setChoosingKind}
          initial={gadget.output && { noun: gadget.output.noun, icon: gadget.output.icon }}
          onSave={async (kind) => {
            if (connection?.blocked()) return false
            // A plural it had is kept while its name stays the same.
            const plural = kind && kind.noun === gadget.output?.noun ? gadget.output.plural : undefined
            await settings.setKind(kind && { ...kind, plural })
            return true
          }}
        />
      )}
      {builds && (
        <AddConnection
          workspaceId={workspaceId}
          open={addingConnection}
          onOpenChange={setAddingConnection}
          to={title || 'the gadget'}
          // Bound at once, not proposed in a chat: whoever builds here chose it.
          onAdded={async ({ gatekeeperId }) => void await settings.bind(gatekeeperId)}
        />
      )}
      {builds && <ShareGadgetDialog workspaceId={workspaceId} gadgetId={workpieceId} title={title ?? 'Gadget'} page={link} open={sharing} onOpenChange={setSharing} />}
      {gadget && (
        <PublishBlueprintDialog
          // Starting from what it is now: a gadget renamed since starts with its new name.
          key={`${gadget.title}\n${description ?? ''}`}
          open={publishing}
          onOpenChange={setPublishing}
          initialTitle={gadget.title}
          initialDescription={description}
          picture={publishPicture.picture}
          onPublish={async (nextTitle, nextDescription) => {
            if (connection?.blocked()) return false
            const blueprint = await settings.publish(nextTitle, nextDescription, await publishPicture.bytes())
            setPublished(blueprint.id)
            return true
          }}
          onOpen={published && onOpenBlueprint ? () => onOpenBlueprint(published) : undefined}
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
