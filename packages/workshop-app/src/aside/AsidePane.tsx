import { useEffect, useRef, useState, type RefObject } from 'react'
import { useNavigate, useRouter } from '@tanstack/react-router'
import { useGadgetAgents } from '@/automations/useGadgetAgents'
import { cn } from '@cloudflare/kumo/utils'
import { FileDashedIcon, LockSimpleIcon, TrayIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { FileView } from '@/blocks/FileView'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { UiUnderway } from '@/blocks/UiUnderway'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { WorktreeView } from '@/blocks/WorktreeView'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { usePointerNearTop } from '@/hooks/usePointerNearTop'
import { accessNotConfirmed, useAskAccessAgain } from '@/connections/ObserverAccessProvider'
import type { CodeLines } from '@/components/CodeEditor'
import { agentKeyOf } from '@/automations/agents'
import { GadgetCodeView, historyEntry } from '@/gadgets/GadgetCodeView'
import { GadgetSettingsPane } from '@/gadgets/GadgetSettingsPane'
import { DEFAULT_GADGET_SETTINGS_TAB, type GadgetSettingsTab } from '@/gadgets/GadgetSettingsView'
import { outputKey } from '@/library/libraryList'
import { recordLibraryOpen } from '@/prefs/libraryOpened'
import { CreateTemplate } from '@/library/CreateTemplate'
import { useMadeTemplates } from '@/library/useMadeTemplates'
import { ShareWorkspaceDialog } from '@/workspaces/ShareWorkspaceDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { formatActivity } from '@/workspaces/formatActivity'
import { useWorkspaceChats } from '@/workspaces/useWorkspaceChats'
import { asideItemIcon } from './asideItemIcon'
import type { AsideFile, AsideItem, AsideOutput } from './asideItems'
import type { GadgetUi } from './GadgetConnection'
import { GadgetAskDock } from './GadgetAskDock'
import { itemChats } from './itemChats'
import { lastShown } from './lastShown'
import { useFilePreview, type FileState } from './useFilePreview'
import { useGadgetConnection } from './useGadgetConnection'
import { SINCE_MADE, useWorktree } from './useWorktree'

export type AsidePaneProps = {
  /** The one shown. */
  item: AsideItem
  /** An address for it, to copy. */
  link?: string
  /**
   * Has it fill the window, or go back. Stable: a gadget's page asks to leave full screen with
   * Escape, through the connection it was made with.
   */
  onFullScreenChange: (on: boolean) => void
  /** Filling a narrow screen, where it does not grow any further (see `SidePane`). */
  narrow?: boolean
  /** Goes to the chat an update of a gadget from its template, made in its settings, was proposed in, which is where it is tried. */
  onUpdateProposed?: (output: AsideOutput, chatId: number) => void
  /** A gadget shown was deleted from its settings: go somewhere that still is. */
  onDeleted?: (output: AsideOutput) => void
} & (
  | {
      /** Beside the page: one of what can be shown beside the chat. */
      placement: 'beside'
      onHide: () => void
      /** Has it take the page's place, when it can. */
      onExpand?: () => void
    }
  | {
      /** The page itself. */
      placement: 'page'
      /**
       * Goes to a gadget's settings page, with the title it has now. Left out where the viewer may
       * not change it, which leaves them out of its menu. Beside the page they are shown in its
       * place instead, for whoever builds in its workspace.
       */
      onOpenSettings?: (output: AsideOutput, title: string) => void
      fullScreen: boolean
      /** Back beside the chat it was expanded from, when it was. */
      onCollapse?: () => void
      /**
       * Goes to a chat in its workspace with it beside it, and `onNewChat` starts one there, greeted
       * by its name. Left out where there is a way back to a chat already, which leaves out Chat.
       */
      onOpenChat?: (chat: { id: number; title?: string }) => void
      onNewChat?: (title: string) => void
    }
)

const paneItem = (item: AsideItem, title = item.title): SidePaneItem => ({ key: item.key, title, icon: asideItemIcon(item) })

/**
 * A file or an output, as the card that shows it: beside the page, or as the page. A gadget runs
 * live in it, and keeps running from one placement to the other: what is shown is keyed by the item
 * alone.
 */
export const AsidePane = (props: AsidePaneProps) => {
  const { item, link, onFullScreenChange, narrow, onUpdateProposed, onDeleted } = props
  const onOpenSettingsPage = props.placement === 'page' ? props.onOpenSettings : undefined
  const fullScreen = props.placement === 'page' && props.fullScreen
  const askAccessAgain = useAskAccessAgain()
  const frame = useRef<HTMLIFrameElement>(null)
  // Full screen, the bar that brings the header back shows as the pointer nears the top, over the
  // gadget's page too, which says where it is in its own frame.
  const pointer = usePointerNearTop(fullScreen, NEAR_TOP)
  const { connection, snapshot } = useGadgetConnection(
    item.kind === 'output' ? item.output : undefined,
    () => onFullScreenChange(false),
    (y) => pointer.report((frame.current?.getBoundingClientRect().top ?? 0) + y),
  )
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])
  const fileState = useFilePreview(item.kind === 'file' ? item.file : undefined)
  // A gadget's, which a worktree, with no settings of its own, is not.
  const gadget = item.kind === 'output' && item.output.type === 'gadget' ? item.output : undefined
  // Opened, beside a chat or a workspace or on its own page, for the Library's Recent tab: here,
  // as wherever it is opened from shows it here.
  const opened = gadget && outputKey(gadget)
  useEffect(() => {
    if (opened) recordLibraryOpen(opened)
  }, [opened])
  // A gadget's settings, connections and code are its workspace's, which whoever it was shared
  // with to use does not build in, rename or delete there.
  const workspaces = useWorkspaces()
  const listed = item.kind === 'output' && workspaces.status === 'ready'
    ? workspaces.workspaces.find(({ id }) => id === item.output.workspaceId)
    : undefined
  const readsCode = gadget !== undefined && listed !== undefined && listed.role !== 'use'
  const title = snapshot.title ?? item.title
  // Its code, shown in its place, over it: the gadget keeps running under it, so that going back is
  // to it as it was, and the code, opened again, is at the file it was left at. Kept by the item it
  // is of, so that another starts as itself.
  const [code, setCode] = useState<{ key: string; open: boolean; file?: string; lines?: CodeLines }>()
  const codeHere = code?.key === item.key ? code : undefined
  const viewingCode = gadget !== undefined && codeHere?.open === true
  // Its settings page, beside the page: the one page that is the route's as the page itself, here
  // in the pane's place, which keeps the gadget running behind it. Kept by the item it is of.
  const [settings, setSettings] = useState<{ key: string; open: boolean; tab: GadgetSettingsTab }>()
  const settingsHere = settings?.key === item.key ? settings : undefined
  const viewingSettings = gadget !== undefined && readsCode && props.placement === 'beside' && settingsHere?.open === true
  const navigate = useNavigate()
  const router = useRouter()
  // As the page, it names the tab; beside one, the page does.
  useDocumentTitle(props.placement === 'page' ? (viewingCode ? `Code · ${title}` : title) : undefined)

  // Whoever builds in its workspace can invite people to a gadget, or make a template from it.
  // Its link is to its own page, without the chat it was shown from, whose changes are not for
  // whoever it lets in.
  const [inviting, setInviting] = useState(false)
  const [creating, setCreating] = useState<boolean>()
  // How copying the template's link last went, for a moment: the Share button says so.
  const [copy, setCopy] = useState<'copied' | 'failed'>()
  useEffect(() => {
    if (!copy) return
    const timer = setTimeout(() => setCopy(undefined), COPY_SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [copy])
  // Refused without permission, and missing on a page not served securely.
  const copyLink = (href: string) => navigator.clipboard.writeText(new URL(href, window.location.href).href).then(() => setCopy('copied'), () => setCopy('failed'))
  const page = link && new URL(link)
  if (page) page.search = ''
  const builds = item.kind === 'output' && item.output.type !== 'worktree' && listed !== undefined && listed.role !== 'use' ? { output: item.output, workspace: listed } : undefined
  // Where it stands as a template, which the Share menu's item says. Read again once the dialog that changes it has closed.
  const made = useMadeTemplates(builds?.output.workspaceId, creating === true)
  const stands: 'none' | 'changes' | 'current' = !made.templates || made.templates.length === 0 ? 'none' : made.templates.some(({ changes }) => changes) ? 'changes' : 'current'
  const templateId = made.templates?.[0]?.id
  const share = builds && (
    <>
      {page && (
        <ShareWorkspaceDialog
          workspaceId={builds.output.workspaceId}
          title={builds.workspace.title || 'Workspace'}
          page={page.href}
          gadget={{ id: builds.output.workpieceId, title }}
          open={inviting}
          onOpenChange={setInviting}
        />
      )}
      {creating !== undefined && (
        <CreateTemplate gadget={{ workspaceId: builds.output.workspaceId, workpieceId: builds.output.workpieceId, title }} open={creating} onOpenChange={setCreating} />
      )}
    </>
  )

  // Escape is for whatever has focus first, such as a menu that is open.
  useEffect(() => {
    if (!fullScreen) return
    const pressed = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onFullScreenChange(false)
    }
    window.addEventListener('keydown', pressed)
    return () => window.removeEventListener('keydown', pressed)
  }, [fullScreen, onFullScreenChange])

  const content = item.kind === 'file' ? (
    <FileContent key={item.key} file={item.file} state={fileState} />
  ) : item.output.type === 'worktree' ? (
    <WorktreeContent key={item.key} worktree={item.output} />
  ) : (
    <>
      {/* One or the other, never both: the gadget is hidden, not gone, while its code is shown, so it keeps running. */}
      <div className={cn('min-h-0 flex-1 flex-col', viewingCode ? 'hidden' : 'flex')}>
        <GadgetView key={item.key} title={title} ui={snapshot.ui} frame={frame} onReload={connection?.reload} onAskAccess={connection && (() => { askAccessAgain(); connection.reconnect() })} />
      </div>
      {viewingCode && gadget && (
        <div className="flex min-h-0 flex-1 flex-col">
          <GadgetCodeView
            key={item.key}
            workspaceId={gadget.workspaceId}
            gadget={{ id: gadget.workpieceId, title, chatId: gadget.chatId }}
            commitId={snapshot.commitId}
            file={codeHere?.file}
            onShowFile={(file) => setCode({ key: item.key, open: true, file })}
            lines={codeHere?.lines}
            onLinesChange={(lines) => setCode((was) => was && { ...was, lines })}
            frame="pane"
          />
        </div>
      )}
      {gadget && (
        <GadgetAskDock
          key={item.key}
          gadget={gadget}
          title={title}
          enabled={readsCode}
          // On a narrow screen what is beside a chat covers it.
          chatInSight={props.placement === 'beside' && !narrow}
          restricted={listed?.containsRestrictedData === true}
        />
      )}
    </>
  )
  // As its own page, a gadget names the workspace it is in and leads to a chat there with it
  // beside it, for whoever builds there: someone given it alone to use has no chats in it.
  const ownPage = props.placement === 'page' ? props : undefined
  const home = ownPage && readsCode ? listed : undefined
  const chatsWith = home && ownPage?.onOpenChat && ownPage.onNewChat ? { onOpenChat: ownPage.onOpenChat, onNewChat: ownPage.onNewChat } : undefined
  const workspaceChats = useWorkspaceChats(chatsWith && home?.id)
  const chats = home && workspaceChats.status !== 'loading'
    // Where they could not be read, there are none to offer, and Chat starts a new one.
    ? itemChats(workspaceChats.status === 'ready' ? workspaceChats.chats : [], home.id, item.key, lastShown)
    : undefined
  const pageParts = home && {
    chat: chatsWith && {
      chats: chats?.map(({ chatId, title: chatTitle, at, showing }) => ({ key: String(chatId), title: chatTitle, time: formatActivity(at), showing })),
      onOpenChat: (key: string) => chatsWith.onOpenChat({ id: Number(key), title: chats?.find(({ chatId }) => String(chatId) === key)?.title }),
      onNewChat: () => chatsWith.onNewChat(title),
    },
  }
  // The agents it starts, beside its title, as it has kept them.
  const gadgetAgents = useGadgetAgents(gadget?.workspaceId, undefined, gadget ? [gadget.workpieceId] : NO_GADGETS)
  const agents = gadget && gadgetAgents.length > 0 ? {
    names: gadgetAgents.map(({ name }) => name),
    onOpen: () => void (gadgetAgents.length === 1
      ? navigate({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId: gadget.workspaceId, agentKey: gadgetAgents[0]!.key } })
      : navigate({ to: '/workspace/$workspaceId', params: { workspaceId: gadget.workspaceId }, search: { tab: 'agents' } })),
  } : undefined
  // Beside the page its settings page is shown in the pane's place; as the page it is the route's.
  const openSettings = gadget && (props.placement === 'beside'
    ? (readsCode ? () => setSettings({ key: item.key, open: true, tab: settingsHere?.tab ?? DEFAULT_GADGET_SETTINGS_TAB }) : undefined)
    : onOpenSettingsPage && (() => onOpenSettingsPage(gadget, title)))
  const shared = {
    active: paneItem(item, title),
    agents,
    people: snapshot.people,
    link,
    onReload: connection?.reload,
    onDownload: fileState.status === 'ready' ? fileState.download : undefined,
    onOpenSettings: openSettings,
    onViewCode: readsCode ? () => setCode({ ...codeHere, key: item.key, open: !viewingCode }) : undefined,
    viewingCode,
    onInvite: builds && page ? () => setInviting(true) : undefined,
    // Up to date, there is nothing to release: what is left to do with it is send people its link.
    template: builds ? { stands, copy, onOpen: stands === 'current' && templateId ? () => void copyLink(router.buildLocation({ to: '/library/templates/$templateId', params: { templateId } }).href) : () => setCreating(true) } : undefined,
    narrow,
  }

  const pane = props.placement === 'beside' ? (
    <SidePane
      {...shared}
      placement="beside"
      onHide={props.onHide}
      onExpand={props.onExpand}
    >
      {content}
      {share}
    </SidePane>
  ) : (
    <SidePane {...shared} {...pageParts} placement="page" onCollapse={props.onCollapse} fullScreen={props.fullScreen} onFullScreenChange={onFullScreenChange} pointerNearTop={pointer.near}>
      {content}
      {share}
    </SidePane>
  )

  return (
    <>
      {viewingSettings && gadget && (
        <GadgetSettingsPane
          workspaceId={gadget.workspaceId}
          workpieceId={gadget.workpieceId}
          initialTitle={title}
          chatId={gadget.chatId}
          namesTab={false}
          tab={settingsHere?.tab ?? DEFAULT_GADGET_SETTINGS_TAB}
          onTabChange={(next) => setSettings({ key: item.key, open: true, tab: next })}
          onBack={() => setSettings({ key: item.key, open: false, tab: settingsHere?.tab ?? DEFAULT_GADGET_SETTINGS_TAB })}
          onDeleted={() => onDeleted?.(gadget)}
          onUpdateProposed={(chatId) => onUpdateProposed?.(gadget, chatId)}
          onOpenAgent={(spawnerId) => void navigate({ to: '/workspace/$workspaceId/agent/$agentKey', params: { workspaceId: gadget.workspaceId, agentKey: agentKeyOf(spawnerId) } })}
        />
      )}
      {/* The settings take the whole pane, header and all. Hidden, not gone, so that the gadget keeps running behind them. */}
      <div className={cn('min-h-0 flex-1 flex-col', viewingSettings ? 'hidden' : 'flex')}>{pane}</div>
    </>
  )
}

export type EmptyAsidePaneProps = {
  /** The library is being read for what the workspace has made. */
  reading: boolean
  /** Why the library could not be read. */
  problem?: string
  /** Reads on after a problem. */
  onRetry?: () => void
  onHide: () => void
  /** Filling a narrow screen (see `SidePane`). */
  narrow?: boolean
}

/**
 * The pane beside a chat with nothing in it yet: opened before what its workspace has made was
 * known, while the library is read for it, and then if it has made nothing.
 */
export const EmptyAsidePane = ({ reading, problem, onRetry, onHide, narrow }: EmptyAsidePaneProps) => (
  <SidePane placement="beside" onHide={onHide} narrow={narrow}>
    {problem ? (
      <PaneNotice
        icon={WarningCircleIcon}
        title="Couldn’t load the library"
        description={problem}
        action={onRetry && { label: 'Try again', onClick: onRetry }}
      />
    ) : reading ? (
      <PaneNotice title="Loading…" />
    ) : (
      <PaneNotice icon={TrayIcon} title="Nothing here yet" description="What this workspace makes shows here." />
    )}
  </SidePane>
)

// How long the Share button shows how copying the template's link went.
const COPY_SHOWN_FOR = 1500

// How near the window's top, in pixels, the pointer brings back the bar to pull the header down by.
const NEAR_TOP = 100

const NO_GADGETS: number[] = []

const GadgetView = ({ title, ui, frame, onReload, onAskAccess }: {
  title: string
  ui: GadgetUi
  frame: RefObject<HTMLIFrameElement | null>
  onReload?: () => void
  /** Opens it again, asking the user to confirm their access, which they did not. */
  onAskAccess?: () => void
}) => {
  switch (ui.status) {
    case 'loading':
      return <PaneNotice title="Loading…" />
    case 'none':
      return <UiUnderway title="Its UI shows here" description="As soon as the gadget builds one." />
    case 'failed':
      // Shared with the user, it reads what is kept at other services, which they confirm their
      // own accounts can see before it opens: cancelled, it is offered again rather than failed.
      if (onAskAccess && accessNotConfirmed(ui.message)) return (
        <PaneNotice
          icon={LockSimpleIcon}
          title={`Confirm your access to open ${title}`}
          description="It was shared with you and reads things kept in other services, such as a Google doc. Before it opens, confirm that your own accounts can see them too."
          action={{ label: 'Confirm access', onClick: onAskAccess }}
        />
      )
      return (
        <PaneNotice
          icon={WarningCircleIcon}
          title={`Couldn’t show ${title}`}
          description={ui.message}
          action={onReload && { label: 'Try again', onClick: onReload }}
        />
      )
    case 'ready':
      // Keyed by the load, so that a reload starts the page over.
      return <GadgetFrame key={ui.load} ref={frame} page={ui.page} title={title} />
  }
}

const SIZE = new Intl.NumberFormat('en', { notation: 'compact', style: 'unit', unit: 'byte', unitDisplay: 'narrow' })

// A worktree's code, and what its agent did to it.
const WorktreeContent = ({ worktree }: { worktree: AsideOutput }) => {
  const { changes, code, show, comparing, compare } = useWorktree(worktree)
  return (
    <WorktreeView
      changes={changes.status === 'ready'
        ? { status: 'ready', changedFiles: changes.changed.size, commits: changes.commits.map(historyEntry) }
        : changes}
      comparing={comparing}
      onCompare={compare}
      since={SINCE_MADE}
      files={code.files}
      shown={code.shown}
      onShow={show}
      file={code.file}
      before={code.before}
      onRetry={code.retry}
    />
  )
}

const FileContent = ({ file, state }: { file: AsideFile; state: FileState }) => {
  switch (state.status) {
    case 'loading':
      return <PaneNotice title="Loading…" />
    case 'unreachable':
      return <PaneNotice icon={FileDashedIcon} title={file.name} description="Open it from the chat it was sent in to see it." />
    case 'failed':
      return <PaneNotice icon={WarningCircleIcon} title={`Couldn’t load ${file.name}`} description={state.message} />
    case 'ready': {
      const details = [file.mimeType, file.size > 0 && SIZE.format(file.size)].filter(Boolean).join(' · ')
      const { preview } = state
      const shared = { name: file.name, details, onDownload: state.download }
      return <FileView {...shared} {...preview} />
    }
  }
}
