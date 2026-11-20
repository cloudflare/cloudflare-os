import { useState } from 'react'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react'
import { asideItemFor, itemPageId, keptVersion } from '@/aside/asideItems'
import { AsidePane } from '@/aside/AsidePane'
import { Sidebar, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Tooltip } from '@/components/Tooltip'
import { ObserverAccessProvider } from '@/connections/ObserverAccessProvider'
import { useNarrowScreen } from '@/hooks/useNarrowScreen'
import { AppShell } from '@/layouts/AppShell'
import { NarrowShell } from '@/layouts/NarrowShell'
import { ApiContext } from '@/rpc/ApiContext'
import { BrokenShareLink } from '@/workspaces/ShareLinkGate'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { WorkspacesProvider } from '@/workspaces/WorkspacesProvider'
import { formatActivity } from '@/workspaces/formatActivity'
import { workspaceLabel } from '@/workspaces/workspaceLabel'
import { createNoAccessApi, NO_ACCESS_CASES, NO_ACCESS_GADGET_ID, NO_ACCESS_WORKSPACE_ID, type NoAccessCase } from './noAccessApi'

const REF = { kind: 'output', workpieceId: NO_ACCESS_GADGET_ID } as const

export type NoAccessPagesProps = {
  which: NoAccessCase
  onSelect: (which: NoAccessCase) => void
  /** A template was made from the app, which is offered where it can't be opened. */
  template: boolean
  onTemplateChange: (template: boolean) => void
}

/**
 * What opening a link to an app shows someone who can't simply open it, each case over a fake
 * backend that answers as the real one does: the real page, in the app's frame, with the real
 * question that asks them to confirm their access, as the pane. Restart starts the case over, and
 * the template is offered or not.
 */
export const NoAccessPages = (props: NoAccessPagesProps) => {
  const { which, template } = props
  const [attempt, setAttempt] = useState(0)
  // The controls under the app rather than over it, so that they cover nothing of it, its foot included.
  return (
    <div className="flex h-dvh flex-col bg-kumo-canvas">
      <div className="min-h-0 flex-1">
        <NoAccessPage key={`${which}/${template}/${attempt}`} which={which} template={template} />
      </div>
      <Controls {...props} onRestart={() => setAttempt((current) => current + 1)} />
    </div>
  )
}

const NoAccessPage = ({ which, template }: { which: NoAccessCase; template: boolean }) => {
  const [session] = useState(() => createNoAccessApi(which, { template }))
  // The link's key is redeemed before anything else is shown (`ShareLinkGate`), and refused here.
  const [linkRefused, setLinkRefused] = useState(which === 'link-off')
  if (linkRefused) return <BrokenShareLink onContinue={() => setLinkRefused(false)} />
  return (
    <ApiContext value={session}>
      <ObserverAccessProvider viewing={NO_ACCESS_WORKSPACE_ID}>
        <WorkspacesProvider>
          <Frame />
        </WorkspacesProvider>
      </ObserverAccessProvider>
    </ApiContext>
  )
}

/** The app's frame as `_app` lays it out for an app's own page (`/app/<id>`), signed in as Ada. */
const Frame = () => {
  const narrow = useNarrowScreen()
  const workspaces = useWorkspaces()
  const [fullScreen, setFullScreen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  // As the page has it from its address alone: nothing names it until the workspace does.
  const item = keptVersion(asideItemFor(NO_ACCESS_WORKSPACE_ID, REF, undefined))
  const listed: SidebarWorkspace[] = workspaces.status === 'ready'
    ? workspaces.workspaces.map(({ id, title, lastActive }) => ({ id, title, workspaceLabel: workspaceLabel(title), subtitle: formatActivity(lastActive) }))
    : []
  const nowhere = { current: false, onOpen: () => {} }
  const sidebar = (collapsed: boolean) => (
    <Sidebar
      user={{ name: 'Ada Lovelace' }}
      workspaces={listed}
      onSelectWorkspace={() => {}}
      onGoHome={() => {}}
      library={nowhere}
      workspacesPage={nowhere}
      automationsPage={nowhere}
      connectionsPage={nowhere}
      settingsPage={nowhere}
      onSignOut={() => {}}
      onSearch={() => {}}
      collapsed={collapsed}
    />
  )
  const pane = (
    <AsidePane
      placement="page"
      item={item}
      link={new URL(`/app/${itemPageId(NO_ACCESS_WORKSPACE_ID, REF)}`, window.location.origin).href}
      fullScreen={!narrow && fullScreen}
      onFullScreenChange={setFullScreen}
      narrow={narrow}
      onBack={narrow ? () => setSidebarOpen(true) : undefined}
    />
  )

  if (narrow) {
    return (
      <NarrowShell sidebar={{ content: sidebar(false), open: sidebarOpen, onOpenChange: setSidebarOpen, button: false }}>
        {pane}
      </NarrowShell>
    )
  }
  return (
    <AppShell sidebar={sidebar} aside={pane} asideAlone asideFullScreen={fullScreen}>
      <div />
    </AppShell>
  )
}

/** The floating panel that picks a case, says what it is, and starts it over. */
const Controls = ({ which, onSelect, template, onTemplateChange, onRestart }: NoAccessPagesProps & { onRestart: () => void }) => {
  const shown = NO_ACCESS_CASES.find(({ id }) => id === which)!
  return (
    <aside
      aria-label="No access case"
      className="mx-auto mb-3 flex max-w-[calc(100vw-1.5rem)] shrink-0 items-center gap-1 overflow-x-auto rounded-full bg-kumo-base p-1 pe-4 text-sm text-kumo-subtle shadow-lg ring-1 ring-kumo-line max-md:pe-1"
    >
      <DropdownMenu label={shown.label} aria-label="Choose case" triggerVariant="ghost" side="top">
        {NO_ACCESS_CASES.map(({ id, label }) => (
          <DropdownMenu.Item key={id} onSelect={() => onSelect(id)}>{label}</DropdownMenu.Item>
        ))}
      </DropdownMenu>
      <Button variant="ghost" icon={ArrowCounterClockwiseIcon} aria-label="Start over" title="Start over" onClick={onRestart} />
      <Button variant="ghost" aria-pressed={template} onClick={() => onTemplateChange(!template)}>{template ? 'With a template' : 'No template'}</Button>
      <Tooltip content={shown.description}>
        <span tabIndex={0} className="max-w-96 truncate max-md:hidden">{shown.description}</span>
      </Tooltip>
    </aside>
  )
}
