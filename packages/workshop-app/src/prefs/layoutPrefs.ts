import { isRecord, stored } from './stored'

/** How this person likes the app laid out, on this device. Never part of what a link shares. */
export type LayoutPrefs = {
  sidebar?: { collapsed: boolean; width: number }
  /** The aside's share of the room beside the sidebar, 0 to 1. */
  asideShare?: number
  /** The aside was showing when last left, so a chat is opened with it showing. */
  asideOpen?: boolean
  /** The Library is shown as a list, or as a grid of tiles. */
  libraryView?: 'list' | 'grid'
  /** The Library is ordered latest first, or by name. */
  librarySort?: 'recent' | 'name'
}

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

const parse = (value: unknown): LayoutPrefs | undefined => {
  if (!isRecord(value)) return undefined
  const { sidebar, asideShare, asideOpen, libraryView, librarySort } = value
  const width = isRecord(sidebar) ? finite(sidebar.width) : undefined
  return {
    sidebar: isRecord(sidebar) && width !== undefined ? { collapsed: sidebar.collapsed === true, width } : undefined,
    asideShare: finite(asideShare),
    asideOpen: typeof asideOpen === 'boolean' ? asideOpen : undefined,
    libraryView: libraryView === 'list' || libraryView === 'grid' ? libraryView : undefined,
    librarySort: librarySort === 'recent' || librarySort === 'name' ? librarySort : undefined,
  }
}

const store = stored<LayoutPrefs>('workshop-app:layout', parse, {})

export const readLayoutPrefs = store.read

/** Keeps `change`, along with what was kept already. */
export const writeLayoutPrefs = (change: LayoutPrefs) => store.write({ ...store.read(), ...change })
