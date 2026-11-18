import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorAccess,
  CollaboratorGrant,
  CollaboratorInfo,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
  ShareLinkInfo,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { parseItemPageId } from '@/aside/asideItems'

/** What a workspace's metadata says of who may share it, as the viewer. */
export type ShareStanding = {
  /** The workspace's owner: the viewer, unless the metadata names someone else. */
  owner: AiChatAuthorInfo
  isOwner: boolean
  /**
   * The viewer can give people access. Only the owner and those who can edit can, and once the
   * workspace has read data that each person must be let in to by the owner, only the owner.
   */
  canShare: boolean
  /** The owner alone can add people (`ownerInvitesOnly`), which a link cannot get round either. */
  ownerOnly: boolean
}

export const shareStanding = (metadata: WorkspaceMetadata, viewer: AiChatAuthorInfo): ShareStanding => {
  const isOwner = metadata.owner === undefined
  const ownerOnly = metadata.ownerInvitesOnly === true
  return {
    owner: metadata.owner ?? viewer,
    isOwner,
    canShare: metadata.role !== 'use' && (isOwner || !ownerOnly),
    ownerOnly,
  }
}

/**
 * What is being shared: a whole workspace, whose people can edit everything in it, or one of its
 * gadgets, whose people can only use it.
 */
export type ShareTarget = { kind: 'workspace' } | { kind: 'gadget'; gadgetId: number; title: string }

/** What sharing `target` gives whoever it is shared with, the server's way. */
export const grantOf = (target: ShareTarget): CollaboratorGrant => (target.kind === 'gadget' ? { gadgetId: target.gadgetId } : 'workspace')

/** Whether someone's access covers what is being shared: editing covers everything, using only the gadgets it names. */
export const covers = (access: CollaboratorAccess, target: ShareTarget) =>
  access.role === 'build' || (target.kind === 'gadget' && access.gadgetIds.includes(target.gadgetId))

/** What someone is, in a few words: a "Member", or someone who uses some of its gadgets. */
export const accessLabel = (access: CollaboratorAccess) => {
  if (access.role === 'build') return 'Member'
  const count = access.gadgetIds.length
  return count === 1 ? 'Uses a gadget' : `Uses ${count} gadgets`
}

/**
 * Whether the viewer may take someone's access away: the owner may take anyone's, and anyone else
 * who can share only what they gave themselves.
 */
export const canChange = (person: CollaboratorInfo, standing: ShareStanding, viewerId: string) =>
  standing.isOwner || (standing.canShare && person.addedBy.some((edge) => edge.type === 'user' && edge.sharer === viewerId))

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Why sharing `target` with `userId` would change nothing, if it would not. The server takes a
 * grant someone already has without complaint, and a typed name gets past any search's
 * exclusions, so this is asked first. Someone who uses some of its gadgets may still be let edit.
 */
export const inviteRefusal = (userId: string, target: ShareTarget, owner: AiChatAuthorInfo, collaborators: readonly CollaboratorInfo[]) => {
  if (sameId(owner.id, userId)) return `${owner.name} owns this workspace.`
  const existing = collaborators.find(({ profile }) => sameId(profile.id, userId))
  if (!existing || !covers(existing.access, target)) return undefined
  if (existing.access.role === 'build') return `${existing.profile.name} is already a member of this workspace.`
  return target.kind === 'gadget' ? `${existing.profile.name} can already use ${target.title}.` : undefined
}

/**
 * Whether a link grants what sharing `target` does: the whole workspace (a link made before roles
 * did), or that one gadget. A link to several gadgets, from before gadgets were shared one at a
 * time, grants neither.
 */
export const linkGrants = (link: ShareLinkInfo, target: ShareTarget) =>
  target.kind === 'gadget'
    ? link.gadgetId === target.gadgetId
    : link.gadgetId === undefined && link.gadgets === undefined && (link.role ?? 'build') === 'build'

/**
 * The viewer's own link to `target`, the one each person has for what they share (`default`):
 * anyone who opens it gets what it grants. Others' links are theirs to turn off.
 */
export const ownLinkOf = (links: readonly ShareLinkInfo[], target: ShareTarget, viewerId: string) =>
  links.find((link) => link.default && link.createdBy.id === viewerId && linkGrants(link, target))

const SHARE = 'share='

/**
 * An address that lets whoever opens it in: `page`, with the link's key in its fragment, which a
 * browser never sends to a server.
 */
export const withShareKey = (page: string, key: string) => {
  const url = new URL(page)
  url.hash = `${SHARE}${key}`
  return url.href
}

/** The key a shared link carries in its fragment (`#share=…`), if it carries one. */
export const shareKeyOf = (hash: string) => {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash
  return fragment.startsWith(SHARE) && fragment.length > SHARE.length ? decodeURIComponent(fragment.slice(SHARE.length)) : undefined
}

/**
 * The workspace a page's path is in: a workspace's own pages, and an item's (`/app/`, `/library/`),
 * which name it first.
 */
export const workspaceOfPath = (pathname: string) => {
  const [first, second] = pathname.split('/').filter(Boolean)
  if (second === undefined) return undefined
  const id = decodeURIComponent(second)
  if (first === 'workspace') return id
  if (first === 'app' || first === 'library') return parseItemPageId(id)?.workspaceId
  return undefined
}

/** What taking someone's access away would do, from the server's preview of it. */
export type RemovalOutcome = {
  /**
   * What is left to them: nothing, only using some of its gadgets (they still have those some
   * other way), or all they had, as they have it some other way too.
   */
  left: 'nothing' | 'use' | 'unchanged'
  /** Those who have it only through them, who lose it too unless kept. */
  dependents: AffectedCollaborator[]
}

export const removalOutcome = (profileId: string, affected: readonly AffectedCollaborator[]): RemovalOutcome => {
  const target = affected.find(({ profile }) => profile.id === profileId)
  return {
    left: !target ? 'unchanged' : target.newAccess === null ? 'nothing' : 'use',
    dependents: affected.filter(({ profile }) => profile.id !== profileId),
  }
}

/** Who added someone, by name, as the removal's list says it: "Ada, Grace", or by a link. */
export const invitedBy = (person: AffectedCollaborator, names: ReadonlyMap<string, string>) =>
  person.addedBy.filter((edge) => edge.type === 'user').map((edge) => names.get(edge.sharer) ?? edge.sharer).join(', ') || 'A link'

/**
 * The services whose accounts someone given it must confirm they can see its data with, by name, in
 * the order its connections were made: those it reads from that need a sign-in. One that sets up an
 * account by itself (Skills, Scheduled Tasks) asks nothing of anyone, so it is left out, as is one
 * not among `vendors`; undefined until the services are known.
 */
export const signInServices = (requirements: readonly ObserverBindingNeed[], vendors: readonly GatekeeperVendorInfo[] | undefined) => {
  if (!vendors) return undefined
  const byId = new Map(vendors.map((vendor) => [vendor.id.toLowerCase(), vendor.description]))
  const names = requirements.flatMap(({ vendorId }) => {
    const vendor = byId.get(vendorId.toLowerCase())
    return vendor && !vendor.autoProvisionsAccount ? [vendor.displayName] : []
  })
  return [...new Set(names)]
}

/** One of what a workspace reads that someone given it must be able to see with their own account. */
export type ProtectedResource = {
  key: string
  /** The connections that reach it, each of which asks the same: several can reach one document. */
  gatekeeperIds: number[]
  title: string
  url?: string
  service: { name: string; logoUrl?: string; color?: string }
}

/**
 * What someone given it must be able to see with their own account before they can open it, by
 * name, in the order its connections were made: those of its connections that need a sign-in, as
 * `signInServices` has them. What several connections reach (the same service, and the same
 * address, or the same title where there is none) is one resource. Undefined until the services
 * are known.
 */
export const protectedResources = (requirements: readonly ObserverBindingNeed[], vendors: readonly GatekeeperVendorInfo[] | undefined): ProtectedResource[] | undefined => {
  if (!vendors) return undefined
  const byId = new Map(vendors.map((vendor) => [vendor.id.toLowerCase(), vendor.description]))
  const resources = new Map<string, ProtectedResource>()
  for (const { gatekeeperId, vendorId, resourceTitle, resourceUrl } of requirements) {
    const vendor = byId.get(vendorId.toLowerCase())
    if (!vendor || vendor.autoProvisionsAccount) continue
    const title = resourceTitle || vendor.displayName
    const key = `${vendorId.toLowerCase()} ${resourceUrl ? `url:${resourceUrl}` : `title:${title}`}`
    const known = resources.get(key)
    if (known) {
      if (!known.gatekeeperIds.includes(gatekeeperId)) known.gatekeeperIds.push(gatekeeperId)
      continue
    }
    resources.set(key, {
      key,
      gatekeeperIds: [gatekeeperId],
      title,
      ...(resourceUrl ? { url: resourceUrl } : {}),
      service: { name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color },
    })
  }
  return [...resources.values()]
}

/** Names as a sentence lists them: "Google", "Google and Slack", "Google, Slack and GitHub". */
export const listed = (names: readonly string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
