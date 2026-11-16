import { isWorkspaceColor, type WorkspaceColor } from '@/components/workspaceLook'
import { isRecord, stored } from '@/prefs/stored'

/** The colour each gadget's mark is drawn in, by `gadgetColorKey`. One that is not there is drawn in ink. */
export type GadgetColorsByKey = Readonly<Partial<Record<string, WorkspaceColor>>>

/** Where the colours are kept between visits. */
export type GadgetColorsStorage = { read: () => GadgetColorsByKey; write: (colors: GadgetColorsByKey) => void }

/** Tells a gadget from every other, across workspaces. */
export const gadgetColorKey = (workspaceId: string, workpieceId: number) => `${workspaceId}/${workpieceId}`

/** The colours in what was kept, leaving out one there no longer is. */
export const parseGadgetColors = (value: unknown): GadgetColorsByKey | undefined =>
  isRecord(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, WorkspaceColor] => isWorkspaceColor(entry[1])))
    : undefined

const kept: GadgetColorsStorage = stored<GadgetColorsByKey>('workshop-app:gadget-colors', parseGadgetColors, {})

/**
 * The colour the user has each gadget's mark drawn in, as a workspace's icon has one
 * (`WorkspaceLooks`). Its icon is the gadget's own (`GadgetFormat.icon`, kept by the server and by
 * blueprints made from it), but the server keeps no colour, so the colours are this device's.
 * Held in one place, so that a colour chosen on the gadget's page changes wherever it is drawn.
 */
export class GadgetColors {
  // Replaced, never changed, so that it can be a snapshot.
  private colors: GadgetColorsByKey
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: GadgetColorsStorage = kept) {
    this.colors = storage.read()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.colors

  /** Has the gadget's mark drawn in `color` from now on; the first colour is ink, which is kept as none. */
  set(key: string, color: WorkspaceColor) {
    // Over what is kept by now, which another tab may have added to since it was read here.
    const { [key]: _was, ...others } = this.storage.read()
    this.colors = color === 'contrast' ? others : { ...others, [key]: color }
    this.storage.write(this.colors)
    for (const listener of this.listeners) listener()
  }
}
