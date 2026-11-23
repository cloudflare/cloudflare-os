import { useState, type ReactNode } from 'react'
import {
  AlertCircleIcon, ArrowLeft01Icon, FileDownIcon, PlugSocketIcon, PlusSignIcon, Share08Icon,
} from '@/components/icons'
import { BindingRow } from '@/blocks/BindingRow'
import { DeveloperIds, type DeveloperId } from '@/blocks/DeveloperIds'
import type { MadeTemplate, TemplateChanges } from '@/blocks/CreateTemplateDialog'
import { ExportItems, type ExportItemsProps } from '@/blocks/ExportItems'
import { Button, ConfirmMenu, DropdownMenu, EditableTitle, EmptyState, HeaderBubble, ListGroup, PageLayout, type SaveOutcome, SettingRow, SettingsCard, SettingsGroup, Tabs } from '@gadgets/ui'
import { MadeTemplateSettings } from '@/blocks/MadeTemplateSettings'
import { ModelBindingDialog, type ModelChoice } from '@/blocks/ModelBindingDialog'
import { PaneNotice } from '@/blocks/PaneNotice'
import { PaneStatus, type PaneStatusProps } from '@/blocks/PaneStatus'
import { WorkspaceCrumb } from '@/blocks/WorkspaceCrumb'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import type { WorkspaceLook } from '@/prefs/preferenceFields'
import { bindingNameProblem, freeBindingName, groupBindings, MODEL_BINDING_NAMES, type GadgetBinding, type Listed } from './GadgetSettings'
import type { BindingService } from './useGadgetSettings'

/** What a gadget's settings page shows beneath its name. */
export type GadgetSettingsTab = 'connections' | 'settings'

export const GADGET_SETTINGS_TABS: { value: GadgetSettingsTab; label: string }[] = [
  { value: 'settings', label: 'Settings' },
  { value: 'connections', label: 'Connections' },
]

/** The tab a gadget's settings start at, which an address leaves out. */
export const DEFAULT_GADGET_SETTINGS_TAB: GadgetSettingsTab = 'settings'

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
  /**
   * Updating it from its template, for a gadget that follows one: whether there is a newer version
   * of it, where that can be told, and the way to have it proposed.
   */
  templateUpdate?: { status?: 'available' | 'upToDate'; onUpdate: () => void }
  /**
   * Templates: the way to the dialog that creates one from it, and those it has made, once they
   * are read, each of which can be released an update or deleted. Left out where it cannot be.
   */
  template?: {
    made?: MadeTemplate[]
    onCreate: () => void
    /** Goes to a template's page. */
    onOpen: (id: string) => void
    /** Keeps a new title and what it is for, rejecting with why it could not. */
    onEdit: (id: string, fields: { title: string; description: string }) => Promise<void>
    /** Releases what its gadget has changed since, as the template lists it. */
    onRelease: (id: string, changes: TemplateChanges) => void
    onDelete: (id: string) => void
    /** The one being released to or deleted, and why the last of those did not go through. */
    busy?: string
    problem?: string
  }
  /** What it can be exported as and saved to, as the More menu offers it (`ExportItems`). */
  exports?: ExportItemsProps
  /** What became of the last export, floated over the foot of the page. */
  status?: PaneStatusProps
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
  /**
   * Starts a chat beside it with the start of asking for a connection written in its composer,
   * where it has none. Left out beside a chat, which is where to ask.
   */
  onConnect?: () => void
  /** Takes a binding away from it, by the name its code knows it by. */
  onUnbind: (name: string) => void
  /** Gives a binding another name in its code: how that went, and why where it did not. */
  onRenameBinding: (name: string, next: string) => Promise<SaveOutcome>
  /**
   * The user's models its code can be given, and the one to start on; the models undefined while
   * they are read. A model binding is named by its model's name as they know it, where it is one.
   */
  models?: { models?: readonly ModelChoice[]; initial?: string }
  /** Has a model binding reach another of the user's models, rejecting with why it could not; `false` where it was not tried. */
  onChangeModel: (name: string, modelId: string) => Promise<boolean | void>
  /** Deletes it, for everyone it is shared with, asked for twice. */
  onDelete: () => void
  /** Back to the gadget itself. */
  onBack: () => void
  /** Goes to the page of the workspace it is in, from the header's crumb. Without it, as in the side pane, there is no crumb. */
  onOpenWorkspace?: () => void
  /** Goes to the page of an agent it starts, by its spawner's id. */
  onOpenAgent?: (spawnerId: number) => void
  /** Where an agent's page is, so that it can be opened in another tab. */
  agentHref?: (spawnerId: number) => string
  /** Its IDs, to copy, in developer mode. */
  ids?: readonly DeveloperId[]
  /** Developer mode: each connection shows, and is renamed by, the name its code knows it by. */
  showsCodeNames?: boolean
  /** What an agent it starts wants of the user, by its spawner's id: a run waiting on them, or a latest run that failed. */
  agentAttention?: (spawnerId: number) => { words: string; tone: 'warning' | 'danger' } | undefined
}

/**
 * A gadget's settings page, laid out as a skill's is: what it is drawn as, its title, renamed
 * where it is, and what its template says it is for, then a tab each (`?tab=`): what it is
 * connected to, with the agents it can start apart, where an AI model is added and changed, and its
 * settings, which are updating it from its template, creating a template from it, exporting it, and
 * deleting it. Only whoever may build in its workspace
 * gets here: anyone it was shared with to use is told that its settings are not theirs.
 */
export const GadgetSettingsView = ({
  state, title, icon, description, templateUpdate, template, exports, status: exported, workspace, tab, onTabChange, onRename, problem, bindings, services, onConnect, onUnbind, onRenameBinding, models, onChangeModel, onDelete, onBack, onOpenWorkspace, onOpenAgent, agentHref, agentAttention, ids = [], showsCodeNames = false,
}: GadgetSettingsViewProps) => {
  const made = template?.made ?? []
  const offersCreate = template !== undefined && made.length === 0
  // What the model dialog was opened for, kept as it closes so that it does not change meanwhile.
  const [modelDialog, setModelDialog] = useState<{ open: boolean; changing?: string; initial?: string }>({ open: false })

  const header = (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5">
      {workspace && onOpenWorkspace && <WorkspaceCrumb id={workspace.id} title={workspace.title} label={workspace.label} look={workspace.look} onOpen={onOpenWorkspace} />}
      <HeaderBubble>
        <Button icon={ArrowLeft01Icon} onClick={onBack}>Back to app</Button>
      </HeaderBubble>
    </nav>
  )
  const framed = (content: ReactNode) => (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PageLayout header={header}>{content}</PageLayout>
      {exported && <PaneStatus {...exported} />}
    </div>
  )

  if (state.status === 'denied' || state.status === 'gone' || state.status === 'failed' || state.status === 'shared') {
    return framed(
      <>
        <div className="flex min-h-[60vh] flex-col">
          {state.status === 'denied' ? (
            <PaneNotice icon={AlertCircleIcon} title={`You don’t have access to ${title || 'this gadget'}`} description="Ask whoever shared it to add you to its workspace." />
          ) : state.status === 'gone' ? (
            <PaneNotice icon={AlertCircleIcon} title="This gadget isn’t here" description="It may have been deleted, or the link is wrong." />
          ) : state.status === 'failed' ? (
            <PaneNotice icon={AlertCircleIcon} title="Couldn’t load the gadget" description={state.message} action={{ label: 'Try again', onClick: state.onRetry }} />
          ) : (
            <PaneNotice
              icon={Share08Icon}
              title={`${title || 'This gadget'} was shared with you`}
              description="Its settings are for whoever builds in its workspace."
              action={{ label: 'Back to app', onClick: onBack }}
            />
          )}
        </div>
      </>,
    )
  }

  const listed = bindings.status === 'ready' ? bindings.items : []
  const { connections, agents } = groupBindings(listed)
  const taken = listed.map(({ name }) => name)
  // A model by the name the user knows it by now, else as it was called when it was given.
  const modelName = (binding: GadgetBinding) => models?.models?.find(({ id }) => id === binding.modelId)?.name
  const row = (binding: GadgetBinding) => (
    <BindingRow
      key={binding.name}
      title={(binding.kind === 'model' && modelName(binding)) || binding.resourceTitle || binding.name}
      name={binding.name}
      service={binding.vendorId === undefined ? undefined : services.get(binding.vendorId)}
      kind={binding.kind === 'service' ? undefined : binding.kind}
      model={binding.model}
      pending={binding.chatId !== undefined}
      gadget={title}
      showsCodeName={showsCodeNames}
      onRemove={() => onUnbind(binding.name)}
      // One waiting in a chat is that chat's until its changes are kept.
      onRename={showsCodeNames && binding.chatId === undefined ? (next) => onRenameBinding(binding.name, next) : undefined}
      // An agent opens its page, where its runs are; one waiting in a chat has none yet.
      onOpen={binding.kind === 'agent' && binding.chatId === undefined && onOpenAgent ? () => onOpenAgent(binding.target) : undefined}
      href={binding.kind === 'agent' && binding.chatId === undefined ? agentHref?.(binding.target) : undefined}
      attention={binding.kind === 'agent' ? agentAttention?.(binding.target) : undefined}
      onChangeModel={binding.kind === 'model' && binding.chatId === undefined ? () => setModelDialog({ open: true, changing: binding.name, initial: binding.modelId }) : undefined}
    />
  )

  return framed(
    <>
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
              {/* The tab says what they are, so they have no heading of their own; the agents, after them, do. */}
              {bindings.status === 'loading' && <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading its connections…</p>}
              {bindings.status === 'failed' && <p role="alert" className="px-5 text-base text-kumo-subtle">Couldn’t load its connections: {bindings.message}</p>}
              {bindings.status === 'ready' && (connections.length === 0
                ? (
                    <EmptyState
                      size="section"
                      tinted
                      icon={PlugSocketIcon}
                      title="No connections yet"
                      description="The services and models it uses on your behalf show here. Ask the agent in a chat to connect it to something."
                      actions={onConnect && [{ label: 'Add connection', icon: PlusSignIcon, variant: 'primary', onClick: onConnect }]}
                    />
                  )
                : (
                    <ListGroup label="Connections">
                      <ul className="flex flex-col">{connections.map(row)}</ul>
                    </ListGroup>
                  ))}
              {/* Only once it has any: most gadgets start none. */}
              {agents.length > 0 && (
                <SettingsGroup title="Agents" description="Agents its code can start, each with a conversation of its own." plain>
                  <ListGroup label="Agents">
                    <ul className="flex flex-col">{agents.map(row)}</ul>
                  </ListGroup>
                </SettingsGroup>
              )}
            </Tabs.Panel>
            <Tabs.Panel value="settings" className="flex flex-col gap-4">
              <SettingsCard>
                {templateUpdate && (
                  <SettingRow
                    title="Updates"
                    description={templateUpdate.status === 'available'
                      ? 'There’s a newer version of its template. The update opens in a new chat, where you can try it before accepting it.'
                      : templateUpdate.status === 'upToDate'
                        ? 'It has the latest version of its template.'
                        : 'Its template may have a newer version. The update opens in a new chat, where you can try it before accepting it.'}
                  >
                    {templateUpdate.status === 'upToDate'
                      ? <span className="shrink-0 text-kumo-subtle">Up to date</span>
                      : <Button variant={templateUpdate.status === 'available' ? 'primary' : 'secondary'} onClick={templateUpdate.onUpdate}>Update…</Button>}
                  </SettingRow>
                )}
                {template && offersCreate && (
                  <SettingRow
                    title="Create template"
                    description="Let others copy your app. They get their own separate copy to start from, connected to their own accounts."
                  >
                    <Button onClick={template.onCreate}>Create template…</Button>
                  </SettingRow>
                )}
                {exports && (
                  <SettingRow title="Export" description="Save it to this device as a file, or to one of your accounts.">
                    <DropdownMenu icon={FileDownIcon} label="Export" caret keepTrigger align="end">
                      <ExportItems {...exports} />
                    </DropdownMenu>
                  </SettingRow>
                )}
                <SettingRow title="Delete this gadget" description="It goes for everyone it’s shared with. What it’s connected to stays in the workspace.">
                  <ConfirmMenu
                    label="Delete gadget"
                    title={`Delete “${title || 'this gadget'}”?`}
                    description="It goes for everyone it’s shared with, with anything set to run it. This can’t be undone."
                    confirmLabel="Delete"
                    onConfirm={onDelete}
                  />
                </SettingRow>
              </SettingsCard>
              <DeveloperIds ids={ids} />
              {template && made.length > 0 && (
                // Its own section, after the rest, once there is a template to look after.
                <div className="mt-8 flex flex-col gap-8">
                  {template.problem && <p role="alert" className="px-5 text-base text-kumo-danger">{template.problem}</p>}
                  {made.map((each) => (
                    <MadeTemplateSettings
                      key={each.id}
                      template={each}
                      title={made.length === 1 ? 'Template' : 'Templates'}
                      busy={template.busy !== undefined}
                      onOpen={() => template.onOpen(each.id)}
                      onEdit={(fields) => template.onEdit(each.id, fields)}
                      onRelease={() => each.changes && template.onRelease(each.id, each.changes)}
                      onDelete={() => template.onDelete(each.id)}
                    />
                  ))}
                </div>
              )}
            </Tabs.Panel>
          </Tabs>
        )}
      </div>
      <ModelBindingDialog
        open={modelDialog.open}
        onOpenChange={(open) => setModelDialog((current) => ({ ...current, open }))}
        gadget={title ? `“${title}”` : 'The gadget'}
        models={models?.models}
        initialModel={modelDialog.initial}
        changing={modelDialog.changing}
        suggestName={(kind) => freeBindingName(MODEL_BINDING_NAMES[kind], taken)}
        nameProblem={(name) => bindingNameProblem(name, taken)}
        onSubmit={({ modelId }) => onChangeModel(modelDialog.changing!, modelId)}
      />
    </>,
  )
}
