import { useEffect, useRef, type RefObject } from 'react'
import { FileDashedIcon, GitBranchIcon, SmileyMehIcon, TrayIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { FileView } from '@/blocks/FileView'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { asideItemIcon } from './asideItemIcon'
import type { AsideFile, AsideItem } from './asideItems'
import type { GadgetUi } from './GadgetConnection'
import { useFilePreview, type FileState } from './useFilePreview'
import { useGadgetConnection } from './useGadgetConnection'

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

const paneItem = (item: AsideItem, title = item.title): SidePaneItem => ({ key: item.key, title, icon: asideItemIcon(item) })

/**
 * A file or an output, as the card that shows it: beside the page, or as the page. A gadget runs
 * live in it, and keeps running from one placement to the other: what is shown is keyed by the item
 * alone.
 */
export const AsidePane = (props: AsidePaneProps) => {
  const { item, link, onFullScreenChange, narrow } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const { connection, snapshot } = useGadgetConnection(item.kind === 'output' ? item.output : undefined, () => onFullScreenChange(false))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])
  const fileState = useFilePreview(item.kind === 'file' ? item.file : undefined)
  const title = snapshot.title ?? item.title
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
  ) : item.output.type === 'worktree' ? (
    <PaneNotice key={item.key} icon={GitBranchIcon} title={title} description="Worktrees will open here once there is a code view." />
  ) : (
    <GadgetView key={item.key} title={title} ui={snapshot.ui} frame={frame} onReload={connection?.reload} />
  )
  const shared = {
    active: paneItem(item, title),
    people: snapshot.people,
    link,
    onReload: connection?.reload,
    onDownload: fileState.status === 'ready' ? fileState.download : undefined,
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
    </SidePane>
  ) : (
    <SidePane {...shared} placement="page" onCollapse={props.onCollapse} fullScreen={props.fullScreen} onFullScreenChange={onFullScreenChange}>
      {content}
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

const GadgetView = ({ title, ui, frame, onReload }: {
  title: string
  ui: GadgetUi
  frame: RefObject<HTMLIFrameElement | null>
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
