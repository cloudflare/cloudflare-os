import { createContext, useContext, useState } from 'react'
import type { ChatAttachment, OutputItem } from '@/chat/chatItems'
import { closeTab, openTab, selectTab, type AsideItem, type AsideTabs } from './asideTabs'

/** What can be done with what is open beside the page. Each is stable. */
export type AsideActions = {
  /** Opens something, and shows the pane if it was hidden. */
  open: (item: AsideItem) => void
  openFile: (file: ChatAttachment) => void
  /** An output is only told from others within its workspace, so it is opened with that. */
  openOutput: (workspaceId: string, output: OutputItem) => void
  /** Shows another of what is open. */
  select: (key: string) => void
  /** Closes one of what is open. Closing the last one puts the pane away with it. */
  closeTab: (key: string) => void
  /** Closes everything, and puts the pane away. */
  closeAll: () => void
  /** Puts the pane away. What is open in it stays open. */
  hide: () => void
  /** Shows the pane, with whatever is open in it. */
  show: () => void
  /** Shows the pane, or puts it away. */
  toggle: () => void
}

export const AsideContext = createContext<AsideActions | null>(null)

/** Opens things beside the page. Only available beneath whoever lays the page out with an aside. */
export const useAside = (): AsideActions => {
  const actions = useContext(AsideContext)
  if (!actions) throw new Error('useAside must be used beneath an AsideContext')
  return actions
}

/** What is open beside the page (see `asideTabs`), if anything, and whether the pane is showing. */
export type AsideState = {
  tabs?: AsideTabs
  shown: boolean
}

/**
 * What is open beside the page, for whoever lays the page out. The pane can be put away with
 * things still open in it, and shown with nothing open.
 */
export const useAsideState = (): AsideState & { actions: AsideActions } => {
  const [state, setState] = useState<AsideState>({ shown: false })
  const [actions] = useState((): AsideActions => {
    const open = (item: AsideItem) => setState(({ tabs }) => ({ tabs: openTab(tabs, item), shown: true }))
    return {
      open,
      openFile: ({ id, name }) => open({ key: `file:${id}`, title: name }),
      openOutput: (workspaceId, { workpieceId, title }) => open({ key: `output:${workspaceId}/${workpieceId}`, title }),
      select: (key) => setState((current) => ({ ...current, tabs: selectTab(current.tabs, key) })),
      closeTab: (key) => setState((current) => {
        const tabs = closeTab(current.tabs, key)
        return { tabs, shown: current.shown && tabs !== undefined }
      }),
      closeAll: () => setState({ shown: false }),
      hide: () => setState((current) => ({ ...current, shown: false })),
      show: () => setState((current) => ({ ...current, shown: true })),
      toggle: () => setState((current) => ({ ...current, shown: !current.shown })),
    }
  })
  return { ...state, actions }
}
