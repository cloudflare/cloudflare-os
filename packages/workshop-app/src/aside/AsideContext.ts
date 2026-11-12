import { createContext, useContext, useState } from 'react'
import type { ChatAttachment, OutputItem } from '@/chat/chatItems'
import { closeTab, openTab, selectTab, type AsideItem, type AsideTabs } from './asideTabs'

/** Where an output was opened from. */
export type OutputSource = {
  /** An output is only told from others within its workspace. */
  workspaceId: string
  /** Opened from a chat, it is shown with the changes proposed there. */
  chatId?: number
}

/** What can be done with what is open beside the page. Each is stable. */
export type AsideActions = {
  /** Opens something, and shows the pane if it was hidden. */
  open: (item: AsideItem) => void
  openFile: (file: ChatAttachment) => void
  openOutput: (source: OutputSource, output: OutputItem) => void
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
  /** Has the pane fill the window, or go back beside the page. */
  setFullScreen: (on: boolean) => void
}

export const AsideContext = createContext<AsideActions | null>(null)

/** Opens things beside the page. Only available beneath whoever lays the page out with an aside. */
export const useAside = (): AsideActions => {
  const actions = useContext(AsideContext)
  if (!actions) throw new Error('useAside must be used beneath an AsideContext')
  return actions
}

/** What is open beside the page (see `asideTabs`), if anything, and how the pane is showing. */
export type AsideState = {
  tabs?: AsideTabs
  shown: boolean
  /** The pane fills the window. Only while it is shown. */
  fullScreen: boolean
}

/**
 * What is open beside the page, for whoever lays the page out. The pane can be put away with
 * things still open in it, and shown with nothing open.
 */
export const useAsideState = (): AsideState & { actions: AsideActions } => {
  const [state, setState] = useState<AsideState>({ shown: false, fullScreen: false })
  const [actions] = useState((): AsideActions => {
    const open = (item: AsideItem) => setState((current) => ({ ...current, tabs: openTab(current.tabs, item), shown: true }))
    return {
      open,
      openFile: (file) => open({ key: `file:${file.id}`, title: file.name, kind: 'file', file }),
      openOutput: ({ workspaceId, chatId }, { workpieceId, title, type, format }) =>
        open({ key: `output:${workspaceId}/${workpieceId}`, title, kind: 'output', output: { workspaceId, workpieceId, type, format, chatId } }),
      select: (key) => setState((current) => ({ ...current, tabs: selectTab(current.tabs, key) })),
      closeTab: (key) => setState((current) => {
        const tabs = closeTab(current.tabs, key)
        const shown = current.shown && tabs !== undefined
        return { tabs, shown, fullScreen: shown && current.fullScreen }
      }),
      closeAll: () => setState({ shown: false, fullScreen: false }),
      hide: () => setState((current) => ({ ...current, shown: false, fullScreen: false })),
      show: () => setState((current) => ({ ...current, shown: true })),
      toggle: () => setState((current) => ({ ...current, shown: !current.shown, fullScreen: false })),
      setFullScreen: (on) => setState((current) => ({ ...current, fullScreen: on && current.shown })),
    }
  })
  return { ...state, actions }
}
