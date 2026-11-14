import { useEffect, useRef, useState, type RefObject } from 'react'
import { FileDashedIcon, GitBranchIcon, SmileyMehIcon, TrayIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { ConnectedFileView } from '@/blocks/ConnectedFileView'
import { FileView } from '@/blocks/FileView'
import { GadgetNoAccess } from '@/blocks/GadgetNoAccess'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { ShareGadgetDialog } from '@/sharing/ShareGadgetDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { asideItemIcon } from './asideItemIcon'
import type { AsideFile, AsideItem, AsideOutput } from './asideItems'
import type { GadgetUi } from './GadgetConnection'
import { OPEN_IN, type ConnectedFileKind } from '@/files/connectedFile'
import { useConnectedFilePreview, type ConnectedFileState } from './useConnectedFilePreview'
import { useFilePreview, type FileState } from './useFilePreview'
import { useGadgetConnection } from './useGadgetConnection'
import { useGadgetExports } from '@/gadgets/useGadgetExports'

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
  /** Goes to a gadget's own settings, from the pane's more. */
  onOpenSettings?: (output: AsideOutput, title: string) => void
} & (
  | {
      /** Beside the page: one of what can be shown beside the chat. */
      placement: 'beside'
      /** What can be shown beside the chat, most recent first. */
      items: AsideItem[]
      onSelect: (key: string) => void
      onHide: () => void
      /** Has it take the page's place, when it can. */
      onExpand?: () => void
    }
  | {
      /** The page itself. */
      placement: 'page'
      fullScreen: boolean
      /** Back beside the chat it was expanded from, when it was. */
      onCollapse?: () => void
    }
)

// Its own page, as it is opened by anyone: not with the changes a chat proposes, which they may not see.
const ownPage = (link: string) => {
  const url = new URL(link)
  url.search = ''
  url.hash = ''
  return url.href
}

const paneItem = (item: AsideItem, title = item.title): SidePaneItem => ({ key: item.key, title, icon: asideItemIcon(item) })

/**
 * A file or an output, as the card that shows it: beside the page, or as the page. A gadget runs
 * live in it, and keeps running from one placement to the other: what is shown is keyed by the item
 * alone.
 */
export const AsidePane = (props: AsidePaneProps) => {
  const { item, link, onFullScreenChange, narrow, onOpenSettings } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const { connection, snapshot } = useGadgetConnection(item.kind === 'output' ? item.output : undefined, () => onFullScreenChange(false))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])
  const fileState = useFilePreview(item.kind === 'file' ? item.file : undefined)
  const connectedState = useConnectedFilePreview(item.kind === 'connected' ? item.connected : undefined)
  // A connected file says what it is, and where it opens, once drawn if not before.
  const drawn = connectedState.status === 'ready' ? connectedState.preview : undefined
  const connectedKind = item.kind === 'connected' ? (item.connected.fileKind ?? (drawn && drawn.content.type)) : undefined
  const editorUrl = item.kind === 'connected' ? (drawn?.url ?? item.connected.url) : undefined
  const title = snapshot.title ?? (item.kind === 'connected' && drawn?.title ? drawn.title : item.title)
  // As the page, it names the tab; beside one, the page does.
  useDocumentTitle(props.placement === 'page' ? title : undefined)

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
  ) : item.kind === 'connected' ? (
    <ConnectedContent key={item.key} title={title} kind={connectedKind} state={connectedState} />
  ) : item.output.type === 'worktree' ? (
    <PaneNotice key={item.key} icon={GitBranchIcon} title={title} description="Worktrees will open here once there is a code view." />
  ) : (
    <GadgetView key={item.key} title={title} ui={snapshot.ui} frame={frame} link={link} onReload={connection?.reload} />
  )
  // A gadget can be shared on its own, by whoever can share what is in its workspace.
  const workspaces = useWorkspaces()
  const [sharing, setSharing] = useState(false)
  const gadget = item.kind === 'output' && item.output.type === 'gadget' ? item.output : undefined
  const listed = gadget && workspaces.status === 'ready' ? workspaces.workspaces.find(({ id }) => id === gadget.workspaceId) : undefined
  const shareable = gadget !== undefined && link !== undefined && listed !== undefined && listed.role !== 'use'
  const share = shareable && (
    <ShareGadgetDialog
      workspaceId={gadget.workspaceId}
      gadgetId={gadget.workpieceId}
      title={title}
      page={ownPage(link)}
      open={sharing}
      onOpenChange={setSharing}
    />
  )

  // A gadget is saved as it is shown: with what the chat it is shown from proposes.
  const exporting = useGadgetExports(gadget && snapshot.ui.status === 'ready' ? gadget : undefined)
  const exports = exporting && {
    formats: exporting.snapshot.formats,
    onRead: () => void exporting.exports.loadFormats(),
    onExport: (id: string) => {
      const format = exporting.snapshot.formats.status === 'ready' ? exporting.snapshot.formats.formats.find((each) => each.id === id) : undefined
      if (format) void exporting.exports.exportAs(format, title)
    },
    progress: exporting.snapshot.progress,
    onDismiss: exporting.exports.dismiss,
  }

  const shared = {
    active: paneItem(item, title),
    people: snapshot.people,
    link,
    onReload: connection?.reload,
    onDownload: fileState.status === 'ready' ? fileState.download : undefined,
    openIn: connectedKind && editorUrl ? { label: OPEN_IN[connectedKind], href: editorUrl } : undefined,
    onShare: shareable ? () => setSharing(true) : undefined,
    // Not for one the viewer cannot open, whose settings they could not see either.
    onOpenSettings: gadget && onOpenSettings && snapshot.ui.status !== 'denied' ? () => onOpenSettings(gadget, title) : undefined,
    exports,
    narrow,
  }

  return props.placement === 'beside' ? (
    <SidePane
      {...shared}
      placement="beside"
      items={props.items.map((candidate) => paneItem(candidate))}
      onSelect={props.onSelect}
      onHide={props.onHide}
      onExpand={props.onExpand}
    >
      {content}
      {share}
    </SidePane>
  ) : (
    <SidePane {...shared} placement="page" onCollapse={props.onCollapse} fullScreen={props.fullScreen} onFullScreenChange={onFullScreenChange}>
      {content}
      {share}
    </SidePane>
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
  <SidePane placement="beside" items={[]} onSelect={() => {}} onHide={onHide} narrow={narrow}>
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

const GadgetView = ({ title, ui, frame, link, onReload }: {
  title: string
  ui: GadgetUi
  frame: RefObject<HTMLIFrameElement | null>
  link?: string
  onReload?: () => void
}) => {
  switch (ui.status) {
    case 'loading':
      return <PaneNotice title="Loading…" />
    case 'none':
      return <PaneNotice icon={SmileyMehIcon} title="No UI yet" description="When the gadget builds one, it will show here." />
    case 'failed':
      return (
        <PaneNotice
          icon={WarningCircleIcon}
          title={`Couldn’t show ${title}`}
          description={ui.message}
          action={onReload && { label: 'Try again', onClick: onReload }}
        />
      )
    case 'denied':
      return <div className="h-full overflow-y-auto"><GadgetNoAccess title={title} link={link ?? window.location.href} /></div>
    case 'ready':
      // Keyed by the load, so that a reload starts the page over.
      return <GadgetFrame key={ui.load} ref={frame} page={ui.page} title={title} />
  }
}

const SIZE = new Intl.NumberFormat('en', { notation: 'compact', style: 'unit', unit: 'byte', unitDisplay: 'narrow' })

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

const ConnectedContent = ({ title, kind, state }: { title: string; kind?: ConnectedFileKind; state: ConnectedFileState }) => {
  switch (state.status) {
    case 'loading':
      // A blank one of its kind stands in, where one is known, so nothing moves when it arrives.
      return kind ? <ConnectedFileView kind={kind} /> : <PaneNotice title="Loading…" />
    case 'none':
      return <PaneNotice icon={FileDashedIcon} title={title} description="It can’t be shown here. Open it in its own editor to see it." />
    case 'failed':
      return <PaneNotice icon={WarningCircleIcon} title={`Couldn’t show ${title}`} description={state.message} action={{ label: 'Try again', onClick: state.retry }} />
    case 'ready':
      return <ConnectedFileView preview={state.preview} kind={state.preview.content.type} />
  }
}
