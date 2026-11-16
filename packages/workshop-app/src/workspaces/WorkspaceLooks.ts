import { isWorkspaceColor, isWorkspaceShape, type WorkspaceLook } from '@/components/workspaceLook'
import { isRecord, stored } from '@/prefs/stored'

/** How each workspace's icon is drawn, by the workspace's id. One that is not there is drawn as any is. */
export type WorkspaceLooksById = Readonly<Partial<Record<string, WorkspaceLook>>>

/** Where the looks are kept between visits. */
export type LooksStorage = { read: () => WorkspaceLooksById; write: (looks: WorkspaceLooksById) => void }

/**
 * The looks in what was kept. A shape or a colour there no longer is, is left out, which leaves
 * that workspace the first of them rather than losing what else was chosen for it.
 */
export const parseLooks = (value: unknown): WorkspaceLooksById | undefined =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value)
          .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
          .map(([id, { shape, color }]) => [id, { shape: isWorkspaceShape(shape) ? shape : undefined, color: isWorkspaceColor(color) ? color : undefined }]),
      )
    : undefined

const kept: LooksStorage = stored<WorkspaceLooksById>('workshop-app:workspace-looks', parseLooks, {})

/**
 * How the user has each workspace's icon drawn: its shape and its colour. The server keeps neither,
 * so they are this device's, and do not follow the user to another browser. Held in one place, so
 * that an icon changed on its workspace's page changes wherever else it is drawn.
 */
export class WorkspaceLooks {
  // Replaced, never changed, so that it can be a snapshot.
  private looks: WorkspaceLooksById
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: LooksStorage = kept) {
    this.looks = storage.read()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  snapshot = () => this.looks

  /** Has the workspace's icon drawn as `look` from now on. */
  set(id: string, look: WorkspaceLook) {
    // Over what is kept by now, which another tab may have added to since it was read here.
    this.looks = { ...this.storage.read(), [id]: look }
    this.storage.write(this.looks)
    for (const listener of this.listeners) listener()
  }
}
