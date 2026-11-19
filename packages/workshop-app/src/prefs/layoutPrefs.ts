import { isRecord, stored } from './stored'

/** How this person likes the app laid out, on this device. Never part of what a link shares. */
export type LayoutPrefs = {
  sidebar?: { collapsed: boolean; width: number }
  /** The aside's share of the room beside the sidebar, 0 to 1. */
  asideShare?: number
  /** The aside was showing when last left, so a chat is opened with it showing. */
  asideOpen?: boolean
  /** A chat's context card, which lists what the chat has, was left open: it is open in every chat until put away. */
  contextOpen?: boolean
  /** What a chat makes is shown beside it as it is made, rather than when asked for. It is, until switched off. */
  opensNewOutputs?: boolean
  /**
   * Where a workspace's chats are listed: in the sidebar's place for the workspaces while one of
   * them is on screen, under each workspace in the sidebar, or in a panel beside the sidebar. Kept
   * to compare them, until one is chosen and the others removed.
   */
  chatsIn?: ChatsPlacement
}

/** Where a workspace's chats are listed (`LayoutPrefs.chatsIn`). */
export type ChatsPlacement = 'zoom' | 'sidebar' | 'panel'

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const parse = (value: unknown): LayoutPrefs | undefined => {
  if (!isRecord(value)) return undefined
  const { sidebar, asideShare, asideOpen, contextOpen, opensNewOutputs, chatsIn } = value
  const width = isRecord(sidebar) ? finite(sidebar.width) : undefined
  return {
    sidebar: isRecord(sidebar) && width !== undefined ? { collapsed: sidebar.collapsed === true, width } : undefined,
    asideShare: finite(asideShare),
    asideOpen: typeof asideOpen === 'boolean' ? asideOpen : undefined,
    contextOpen: typeof contextOpen === 'boolean' ? contextOpen : undefined,
    opensNewOutputs: typeof opensNewOutputs === 'boolean' ? opensNewOutputs : undefined,
    chatsIn: chatsIn === 'zoom' || chatsIn === 'sidebar' || chatsIn === 'panel' ? chatsIn : undefined,
  }
}

const store = stored<LayoutPrefs>('workshop-app:layout', parse, {})

export const readLayoutPrefs = store.read

/** Keeps `change`, along with what was kept already. */
export const writeLayoutPrefs = (change: LayoutPrefs) => store.write({ ...store.read(), ...change })
