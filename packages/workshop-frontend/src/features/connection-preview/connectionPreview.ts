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
export const previewOf = (entry: ActionLogEntry & { gatekeeperId: WorkpieceId }): ConnectionPreview => ({
  gatekeeperId: entry.gatekeeperId,
  title: entry.resourceTitle,
  url: safeExternalUrl(entry.resourceUrl) ?? undefined,
})

const offers = new WeakMap<RpcStub<Overseer>, Map<WorkpieceId, Promise<boolean>>>()

const describesPreview = async (overseer: RpcStub<Overseer>, gatekeeperId: WorkpieceId) => {
  const client = overseer.getGatekeeperById(gatekeeperId)
  try {
    return (await client.describe()).hasPreview === true
  } catch {
    return false
  } finally {
    client[Symbol.dispose]()
  }
}

/**
 * Whether a connection offers a preview. Asked once per connection: describing a resource can
 * cost its gatekeeper calls to its provider.
 */
export const offersPreview = (overseer: RpcStub<Overseer>, gatekeeperId: WorkpieceId) => {
  let known = offers.get(overseer)
  if (!known) offers.set(overseer, known = new Map())
  let offer = known.get(gatekeeperId)
  if (!offer) known.set(gatekeeperId, offer = describesPreview(overseer, gatekeeperId))
  return offer
}
