import { useEffect, useRef, useState, type RefObject } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { FileDashedIcon, SmileyMehIcon, TrayIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { FileView } from '@/blocks/FileView'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { PaneNotice } from '@/blocks/PaneNotice'
import { PaneStatus } from '@/blocks/PaneStatus'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { WorktreeView } from '@/blocks/WorktreeView'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import type { CodeLines } from '@/components/CodeEditor'
import { GadgetCodeView, historyEntry } from '@/gadgets/GadgetCodeView'
import { useGadgetExports } from '@/gadgets/useGadgetExports'
import { templateUpdateStatus } from '@/gadgets/templateUpdate'
import { UpdateFromTemplate } from '@/gadgets/UpdateFromTemplate'
import { useBlueprintInfo } from '@/gadgets/useGadgetSettings'
import { ShareWorkspaceDialog } from '@/workspaces/ShareWorkspaceDialog'
import { useWorkspaces } from '@/workspaces/WorkspacesContext'
import { asideItemIcon } from './asideItemIcon'
import type { AsideFile, AsideItem, AsideOutput } from './asideItems'
import type { GadgetUi } from './GadgetConnection'
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
  /**
   * Goes to a gadget's settings, with the title it has now. Left out where
   * the viewer may not change it, which leaves them out of its menu.
   */
  onOpenSettings?: (output: AsideOutput, title: string) => void
  /**
   * Goes to the chat an update of a gadget from its template was proposed in, which is where it is
   * tried. Left out where there is nowhere to go, which leaves the update out of its menu.
   */
  onUpdateProposed?: (output: AsideOutput, chatId: number) => void
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
  const { item, link, onFullScreenChange, narrow, onOpenSettings, onUpdateProposed } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const { connection, snapshot } = useGadgetConnection(item.kind === 'output' ? item.output : undefined, () => onFullScreenChange(false))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])
  const fileState = useFilePreview(item.kind === 'file' ? item.file : undefined)
  const title = snapshot.title ?? item.title
  // A gadget's, which a worktree, with no settings of its own, is not.
  const gadget = item.kind === 'output' && item.output.type === 'gadget' ? item.output : undefined
  // Its code, shown in its place, over it: the gadget keeps running under it, so that going back is
  // to it as it was, and the code, opened again, is at the file it was left at. Kept by the item it
  // is of, so that another starts as itself.
  const [code, setCode] = useState<{ key: string; open: boolean; file?: string; lines?: CodeLines }>()
  const codeHere = code?.key === item.key ? code : undefined
  const viewingCode = gadget !== undefined && codeHere?.open === true
  // As the page, it names the tab; beside one, the page does.
  useDocumentTitle(props.placement === 'page' ? (viewingCode ? `Code · ${title}` : title) : undefined)
  const reduceMotion = useReducedMotion() ?? false

  // A gadget is shared with its workspace, by whoever can share what is in it. Its link is to its
  // own page, without the chat it was shown from, whose changes are not for whoever it lets in.
  const workspaces = useWorkspaces()
  const listed = item.kind === 'output' && workspaces.status === 'ready'
    ? workspaces.workspaces.find(({ id }) => id === item.output.workspaceId)
    : undefined
  const [sharing, setSharing] = useState(false)
  const page = link && new URL(link)
  if (page) page.search = ''
  const share = item.kind === 'output' && item.output.type !== 'worktree' && listed !== undefined && listed.role !== 'use' && page && (
    <ShareWorkspaceDialog
      workspaceId={item.output.workspaceId}
      title={listed.title || 'Workspace'}
      page={page.href}
      gadget={{ id: item.output.workpieceId, title }}
      open={sharing}
      onOpenChange={setSharing}
    />
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
      <div inert={viewingCode} className="flex min-h-0 flex-1 flex-col">
        <GadgetView key={item.key} title={title} ui={snapshot.ui} frame={frame} onReload={connection?.reload} />
      </div>
      <AnimatePresence initial={false}>
        {viewingCode && gadget && (
          <motion.div
            key={`code:${item.key}`}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.995 }}
            transition={{ type: 'spring', duration: 0.38, bounce: 0 }}
            className="absolute inset-0 flex flex-col bg-kumo-tint"
          >
            <GadgetCodeView
              workspaceId={gadget.workspaceId}
              commitId={snapshot.commitId}
              file={codeHere?.file}
              onShowFile={(file) => setCode({ key: item.key, open: true, file })}
              lines={codeHere?.lines}
              onLinesChange={(lines) => setCode((was) => was && { ...was, lines })}
              frame="pane"
            />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
  // Its code is its workspace's, which whoever it was shared with to use does not build in.
  const readsCode = gadget !== undefined && listed !== undefined && listed.role !== 'use'
  // Exported by whoever can use it, and saved to their accounts by whoever builds there.
  const exports = useGadgetExports(gadget, title, { saves: readsCode })
  // A newer version of the template it follows, which its menu offers to update it to. Only a
  // gadget with code of its own takes one: one still waiting in a chat has none. Its settings
  // offer the update whether or not there is one.
  const upstream = gadget && snapshot.upstream
  const template = useBlueprintInfo(upstream?.blueprintId, upstream?.commitId)
  const follows = readsCode && upstream?.blueprintId !== undefined && snapshot.commitId !== undefined ? { ...upstream, blueprintId: upstream.blueprintId } : undefined
  const [updating, setUpdating] = useState(false)
  const update = gadget && follows && template && onUpdateProposed && (
    <UpdateFromTemplate
      open={updating}
      onOpenChange={setUpdating}
      workspaceId={gadget.workspaceId}
      gadgetId={gadget.workpieceId}
      title={title}
      upstream={follows}
      template={template}
      onProposed={(chatId) => onUpdateProposed(gadget, chatId)}
    />
  )
  const hasUpdate = update && templateUpdateStatus(follows, template) === 'available'
  const shared = {
    active: paneItem(item, title),
    people: snapshot.people,
    link,
    onReload: connection?.reload,
    onDownload: fileState.status === 'ready' ? fileState.download : undefined,
    exports: exports.menu,
    onOpenSettings: gadget && onOpenSettings && (() => onOpenSettings(gadget, title)),
    onViewCode: readsCode ? () => setCode({ ...codeHere, key: item.key, open: !viewingCode }) : undefined,
    viewingCode,
    onShare: share ? () => setSharing(true) : undefined,
    onUpdate: hasUpdate ? () => setUpdating(true) : undefined,
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
      {exports.status && <PaneStatus {...exports.status} />}
      {share}
      {exports.dialogs}
      {update}
    </SidePane>
  ) : (
    <SidePane {...shared} placement="page" onCollapse={props.onCollapse} fullScreen={props.fullScreen} onFullScreenChange={onFullScreenChange}>
      {content}
      {exports.status && <PaneStatus {...exports.status} />}
      {share}
      {exports.dialogs}
      {update}
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
