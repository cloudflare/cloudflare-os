import type { GadgetClient } from '@gadgets/workshop-shared/api'

/** The part of a gadget renaming and deleting it use, and the lease that must be disposed. */
export type ChangedGadget = Pick<GadgetClient, 'setTitle' | 'remove'> & Disposable

/** The part of a workspace's Overseer they use, and the lease that must be disposed. */
export type ChangingOverseer = { getGadget(id: number): ChangedGadget } & Disposable

/**
 * Does `change` to the gadget `workpieceId` in the workspace `open` opens, for a moment: the
 * gadget is asked for without waiting for the workspace, and both are let go of once it is done,
 * whether or not it was. Rejects with why it could not be.
 */
export const changeGadget = async (open: () => ChangingOverseer, workpieceId: number, change: (gadget: ChangedGadget) => Promise<void>) => {
  const overseer = open()
  const gadget = overseer.getGadget(workpieceId)
  try {
    await change(gadget)
  } finally {
    gadget[Symbol.dispose]()
    overseer[Symbol.dispose]()
  }
}

/** Gives the gadget another title, for everyone with access to its workspace. */
export const renameGadget = (open: () => ChangingOverseer, workpieceId: number, title: string) =>
  changeGadget(open, workpieceId, (gadget) => gadget.setTitle(title))

/** Deletes the gadget, for everyone with access to its workspace. */
export const deleteGadget = (open: () => ChangingOverseer, workpieceId: number) =>
  changeGadget(open, workpieceId, (gadget) => gadget.remove())

/**
 * A title the user gave something, `to`, over the one it had, `from`, until what it is read as has
 * caught up: shown in its place while it still reads as `from`, and no longer once it reads as
 * anything else, the new title included, so that a rename made since by someone else shows.
 */
export type Renamed = { from: string; to: string }

/** What `title` is shown as, after `renamed`. */
export const titleAfter = (title: string, renamed: Renamed | undefined) => (renamed && renamed.from === title ? renamed.to : title)
