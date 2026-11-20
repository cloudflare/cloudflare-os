import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, GatekeeperCreationSpec, GatekeeperVendorInfo, Overseer, WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { findResourceType } from '@gadgets/workshop-shared/gatekeeper'
import { safeExternalUrl } from '../../utils/safeExternalUrl'

/** A connection's content, or one item of it, that can be drawn beside the chat. */
export type ConnectionPreview = {
  gatekeeperId: WorkpieceId
  /** The one item drawn, by its gatekeeper's name for it: a file of a folder connection. */
  item?: string
  title: string
  /** The real file, for the pane's link out. */
  url?: string
  /** The icon of the connection's type of resource, when its vendor gives one. */
  iconUrl?: string
}

/** Lists the vendors with their types of resource, as `AuthenticatedApi.listGatekeeperVendors()` does. */
export type ListVendors = () => PromiseLike<GatekeeperVendorInfo[]>

/** What a connection that offers a preview says of it: its file as it is now, not as a change waiting recorded it. */
export type PreviewOffer = Pick<ConnectionPreview, 'iconUrl' | 'url'>

/** The item `entry` says it changes, when its gatekeeper can draw that item by itself. */
export const itemOf = (entry: ActionLogEntry) =>
  entry.type === 'action' ? entry.description.previewOf : undefined

/** The preview `offer`ed for `entry`: of the item it changes, or else of the connection it was logged on. */
export const previewOf = (
  gatekeeperId: WorkpieceId, entry: ActionLogEntry, offer?: PreviewOffer,
): ConnectionPreview => {
  const item = itemOf(entry)
  return {
    gatekeeperId,
    item: item?.id,
    title: item?.title ?? entry.resourceTitle,
    // An item with no address of its own has no link out: the connection's is to something else.
    url: safeExternalUrl(item ? item.url : entry.resourceUrl) ?? undefined,
    iconUrl: offer?.iconUrl,
  }
}

/**
 * What the session of a connection whose actions name items offers: the session an item's
 * preview draws from, in place of the connection's own.
 */
export type ItemPreviews = { openPreview(item: string): RpcStub<object> }

/** What tells one preview from another: its connection and, of a connection with several, its item. */
export const previewKey = ({ gatekeeperId, item = '' }: Pick<ConnectionPreview, 'gatekeeperId' | 'item'>) =>
  `${gatekeeperId} ${item}`

/** The icon the vendor gives the connection's type of resource. */
const typeIcon = (spec: GatekeeperCreationSpec, vendors: GatekeeperVendorInfo[]) => {
  if (spec.type !== 'gatekeeper') return undefined
  const types = vendors.find(vendor => vendor.id === spec.vendorId)?.supportedResources ?? []
  return findResourceType(types, spec.resourceTypeId, spec.typeUrlPattern)?.icon?.url
}

/** What is offered of a preview, if one is. Rejects when its connection could not be asked. */
export type OffersPreview = (
  overseer: RpcStub<Overseer>, preview: Pick<ConnectionPreview, 'gatekeeperId' | 'item'>,
) => Promise<PreviewOffer | undefined>

/**
 * The asking of one workspace's connections, where a number means one connection. Each is asked
 * until it answers, then no more for as long as this is kept, by whichever overseer reaches it:
 * describing a resource can cost its gatekeeper calls to its provider. A connection whose
 * resource is yet to be created is asked each time, as what it says changes when it is.
 */
export const previewOffers = (listVendors: ListVendors): OffersPreview => {
  const known = new Map<WorkpieceId, Promise<PreviewOffer | undefined>>()
  let vendors: Promise<GatekeeperVendorInfo[]> | undefined
  const listed = () => vendors ??= Promise.resolve(listVendors()).catch(error => {
    vendors = undefined
    throw error
  })

  const describes = async (overseer: RpcStub<Overseer>, gatekeeperId: WorkpieceId) => {
    const client = overseer.getGatekeeperById(gatekeeperId)
    try {
      const { hasPreview, url } = await client.describe()
      if (!hasPreview) return undefined
      const spec = await client.getCreationSpec().catch(() => undefined)
      if (spec?.type === 'gatekeeper' && !spec.resourceUrl) known.delete(gatekeeperId)
      // A preview whose type cannot be told is drawn without an icon.
      const iconUrl = spec && typeIcon(spec, await listed().catch(() => []))
      const file = safeExternalUrl(url)
      return { iconUrl, ...file ? { url: file } : {} }
    } finally {
      client[Symbol.dispose]()
    }
  }

  return (overseer, { gatekeeperId, item }) => {
    // An action that names an item is itself the offer of that item's preview.
    if (item !== undefined) return Promise.resolve({})
    let offer = known.get(gatekeeperId)
    if (!offer) {
      known.set(gatekeeperId, offer = describes(overseer, gatekeeperId))
      // Not an answer: the next asking describes the connection again.
      offer.catch(() => known.delete(gatekeeperId))
    }
    return offer
  }
}
