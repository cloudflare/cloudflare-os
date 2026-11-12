import { isRecord, stored } from './stored'

/** How this person likes the app laid out, on this device. Never part of what a link shares. */
export type LayoutPrefs = {
  sidebar?: { collapsed: boolean; width: number }
  /** The aside's share of the room beside the sidebar, 0 to 1. */
  asideShare?: number
  /** The aside was showing when last left, so a chat is opened with it showing. */
  asideOpen?: boolean
}

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const parse = (value: unknown): LayoutPrefs | undefined => {
  if (!isRecord(value)) return undefined
  const { sidebar, asideShare, asideOpen } = value
  const width = isRecord(sidebar) ? finite(sidebar.width) : undefined
  return {
    sidebar: isRecord(sidebar) && width !== undefined ? { collapsed: sidebar.collapsed === true, width } : undefined,
    asideShare: finite(asideShare),
    asideOpen: typeof asideOpen === 'boolean' ? asideOpen : undefined,
  }
}

const store = stored<LayoutPrefs>('workshop-app:layout', parse, {})

export const readLayoutPrefs = store.read

/** Keeps `change`, along with what was kept already. */
export const writeLayoutPrefs = (change: LayoutPrefs) => store.write({ ...store.read(), ...change })
