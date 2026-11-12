import { useEffect, useRef, type RefObject } from 'react'
import { FileDashedIcon, GitBranchIcon, SidebarSimpleIcon, SmileyMehIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { attachmentKind } from '@/blocks/attachmentKind'
import { ATTACHMENT_KIND_ICONS } from '@/blocks/attachmentKindIcons'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { FormatIcon } from '@/components/FormatIcon'
import type { AsideActions } from './AsideContext'
import type { AsideItem, AsideTabs } from './asideTabs'
import type { GadgetUi } from './GadgetConnection'
import { useGadgetConnection } from './useGadgetConnection'

export type AsidePaneProps = {
  /** What is open, if anything. */
  tabs?: AsideTabs
  fullScreen: boolean
  actions: AsideActions
  /**
   * Goes to the chat in a workspace that was active last, for an output of it that was filling
   * the window: the app's mark there leaves full screen for that chat, with the output beside it.
   */
  onOpenLatestChat?: (workspaceId: string) => void
}

const iconFor = (item: AsideItem) => {
  if (item.kind === 'output') {
    return item.output.type === 'worktree' ? <GitBranchIcon aria-hidden="true" /> : <FormatIcon name={item.output.format?.icon} />
  }
  const Glyph = ATTACHMENT_KIND_ICONS[attachmentKind({ name: item.file.name, type: item.file.mimeType })]
  return <Glyph aria-hidden="true" />
}

// Where the shipped Workshop opens an output, as its own page.
const linkTo = (item: AsideItem) =>
  item.kind === 'output' && item.output.type === 'gadget'
    ? new URL(`/workspace/${encodeURIComponent(item.output.workspaceId)}?w=${item.output.workpieceId}`, window.location.origin).href
    : undefined

/** What is open beside the page, as the pane that shows it. A gadget runs live in it. */
export const AsidePane = ({ tabs, fullScreen, actions, onOpenLatestChat }: AsidePaneProps) => {
  const active = tabs?.items.find(({ key }) => key === tabs.activeKey)
  const { connection, snapshot } = useGadgetConnection(active?.kind === 'output' ? active.output : undefined, () => actions.setFullScreen(false))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])

  // Escape is for whatever has focus first, such as a menu that is open.
  useEffect(() => {
    if (!fullScreen) return
    const pressed = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) actions.setFullScreen(false)
    }
    window.addEventListener('keydown', pressed)
    return () => window.removeEventListener('keydown', pressed)
  }, [fullScreen, actions])

  const items: SidePaneItem[] = (tabs?.items ?? []).map((item) => ({ key: item.key, title: item.title, icon: iconFor(item) }))

  return (
    <SidePane
      items={items}
      activeKey={tabs?.activeKey}
      onSelect={actions.select}
      onCloseItem={actions.closeTab}
      onCloseAll={actions.closeAll}
      onHide={actions.hide}
      people={snapshot.people}
      link={active && linkTo(active)}
      onReload={connection?.reload}
      fullScreen={fullScreen}
      onFullScreenChange={actions.setFullScreen}
      onHome={() => {
        actions.setFullScreen(false)
        if (active?.kind === 'output') onOpenLatestChat?.(active.output.workspaceId)
      }}
    >
      {!active ? (
        <PaneNotice icon={SidebarSimpleIcon} title="Nothing open" description="Outputs and files you open from a chat show here." />
      ) : active.kind === 'file' ? (
        <PaneNotice key={active.key} icon={FileDashedIcon} title={active.title} description="Previews of files are still to come." />
      ) : active.output.type === 'worktree' ? (
        <PaneNotice key={active.key} icon={GitBranchIcon} title={active.title} description="Worktrees will open here once there is a code view." />
      ) : (
        <GadgetView key={active.key} title={active.title} ui={snapshot.ui} frame={frame} onReload={connection?.reload} />
      )}
    </SidePane>
  )
}

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
