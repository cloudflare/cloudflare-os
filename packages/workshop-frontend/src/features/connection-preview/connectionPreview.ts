import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

/** A connection whose content can be drawn beside the chat. */
export type ConnectionPreview = {
  gatekeeperId: WorkpieceId
  title: string
  /** The real file, for the pane's link out. */
  url?: string
}

/** The preview of the connection `entry` was logged on, should that connection offer one. */
export const previewOf = (gatekeeperId: WorkpieceId, entry: ActionLogEntry): ConnectionPreview => ({
  gatekeeperId,
  title: entry.resourceTitle,
  url: safeExternalUrl(entry.resourceUrl) ?? undefined,
})

/** Whether a connection offers a preview. Rejects when the connection could not be asked. */
export type OffersPreview = (overseer: RpcStub<Overseer>, gatekeeperId: WorkpieceId) => Promise<boolean>

/**
 * The asking of one workspace's connections, where a number means one connection. Each is asked
 * until it answers, then no more for as long as this is kept, by whichever overseer reaches it:
 * describing a resource can cost its gatekeeper calls to its provider.
 */
export const previewOffers = (): OffersPreview => {
  const known = new Map<WorkpieceId, Promise<boolean>>()

  const describes = async (overseer: RpcStub<Overseer>, gatekeeperId: WorkpieceId) => {
    const client = overseer.getGatekeeperById(gatekeeperId)
    try {
      return (await client.describe()).hasPreview === true
    } finally {
      client[Symbol.dispose]()
    }
  }

  return (overseer, gatekeeperId) => {
    let offer = known.get(gatekeeperId)
    if (!offer) {
      known.set(gatekeeperId, offer = describes(overseer, gatekeeperId))
      // Not an answer: the next asking describes the connection again.
      offer.catch(() => known.delete(gatekeeperId))
    }
    return offer
  }
}
