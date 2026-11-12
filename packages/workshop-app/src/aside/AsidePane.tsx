import { useEffect, useRef, type RefObject } from 'react'
import { FileDashedIcon, GitBranchIcon, SmileyMehIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { GadgetFrame } from '@/blocks/GadgetFrame'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SidePane, type SidePaneItem } from '@/blocks/SidePane'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { asideItemIcon } from './asideItemIcon'
import type { AsideItem } from './asideItems'
import type { GadgetUi } from './GadgetConnection'
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
} & (
  | {
      /** Beside the page: one of what the chat has to show. */
      placement: 'beside'
      /** What the chat has to show, most recent first. */
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
  const { item, link, onFullScreenChange } = props
  const fullScreen = props.placement === 'page' && props.fullScreen
  const { connection, snapshot } = useGadgetConnection(item.kind === 'output' ? item.output : undefined, () => onFullScreenChange(false))
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => connection?.showIn(() => frame.current?.contentWindow), [connection])
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
    <PaneNotice key={item.key} icon={FileDashedIcon} title={title} description="Previews of files are still to come." />
  ) : item.output.type === 'worktree' ? (
    <PaneNotice key={item.key} icon={GitBranchIcon} title={title} description="Worktrees will open here once there is a code view." />
  ) : (
    <GadgetView key={item.key} title={title} ui={snapshot.ui} frame={frame} onReload={connection?.reload} />
  )
  const shared = { active: paneItem(item, title), people: snapshot.people, link, onReload: connection?.reload }

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
