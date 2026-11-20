import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorAccess,
  CollaboratorGrant,
  CollaboratorInfo,
  GatekeeperVendorInfo,
  ObserverBindingNeed,
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
 * One of what a workspace reads that someone given it must be able to see with their own account,
 * with the connections that read it (`needs`): several often read the same one, which is the one
 * thing to see.
 */
export type ProtectedResource = {
  /** Which it is (`resourceIdentity`). */
  key: string
  title: string
  url?: string
  vendorId: string
  service: { name: string; logoUrl?: string; color?: string }
  needs: ObserverBindingNeed[]
}

/**
 * Which resource a connection reads, the same for every connection that reads it: its service and
 * its address, or, without one, its title.
 */
export const resourceIdentity = ({ vendorId, resourceUrl, resourceTitle }: Pick<ObserverBindingNeed, 'vendorId' | 'resourceUrl' | 'resourceTitle'>) =>
  `${vendorId.toLowerCase()} ${resourceUrl ? `url:${resourceUrl}` : `title:${resourceTitle}`}`

/**
 * What someone given it must be able to see with their own account before they can open it, by
 * name, in the order its connections were made: those of its connections that need a sign-in, each
 * resource once however many of its connections read it. One whose service sets up an account by
 * itself (Skills, Scheduled Tasks) asks nothing of anyone, so it is left out, as is one not among
 * `vendors`. Undefined until the services are known.
 *
 * With `every`, it is every one of them, for confirming access, where each connection has to be
 * answered: those whose service sets up an account by itself, and any of a service not known here,
 * named by its id.
 */
export const protectedResources = (requirements: readonly ObserverBindingNeed[], vendors: readonly GatekeeperVendorInfo[] | undefined, { every = false } = {}): ProtectedResource[] | undefined => {
  if (!vendors) return undefined
  const byId = new Map(vendors.map((vendor) => [vendor.id.toLowerCase(), vendor.description]))
  const resources = new Map<string, ProtectedResource>()
  for (const need of requirements) {
    const known = byId.get(need.vendorId.toLowerCase())
    if (!every && (!known || known.autoProvisionsAccount)) continue
    const vendor = known ?? { displayName: need.vendorId, logo: undefined, color: undefined }
    const key = resourceIdentity(need)
    const listed = resources.get(key)
    if (listed) {
      if (!listed.needs.some(({ gatekeeperId }) => gatekeeperId === need.gatekeeperId)) listed.needs.push(need)
      continue
    }
    resources.set(key, {
      key,
      title: need.resourceTitle || vendor.displayName,
      ...(need.resourceUrl ? { url: need.resourceUrl } : {}),
      vendorId: need.vendorId,
      service: { name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color },
      needs: [need],
    })
  }
  return [...resources.values()]
}

/** Names as a sentence lists them: "Google", "Google and Slack", "Google, Slack and GitHub". */
export const listed = (names: readonly string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
