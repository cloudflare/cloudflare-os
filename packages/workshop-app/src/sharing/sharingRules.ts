import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorInfo,
  ShareLinkInfo,
  WorkpieceId,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import { parseItemPageId } from '@/aside/asideItems'

/** How someone given a gadget may open it: live, or only as its owner's snapshot. */
export type GadgetLevel = 'use' | 'view'

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

/** The workspace's members, who can edit everything in it: those it is shared with whole. */
export const membersOf = (collaborators: readonly CollaboratorInfo[], owner: AiChatAuthorInfo) =>
  collaborators.filter(({ profile, access }) => access.role === 'build' && profile.id !== owner.id)

/** The people a gadget was given to on its own, rather than with the workspace. */
export const holdersOf = (collaborators: readonly CollaboratorInfo[], gadgetId: WorkpieceId) =>
  collaborators.filter(({ access }) => access.role === 'use' && access.gadgetIds.includes(gadgetId))

export const levelOf = ({ access }: CollaboratorInfo, gadgetId: WorkpieceId): GadgetLevel =>
  access.role === 'use' && access.viewOnly?.includes(gadgetId) ? 'view' : 'use'

/**
 * Whether the viewer may change what someone has: the owner may change anyone's, and anyone else
 * who can share only what they gave themselves.
 */
export const canChange = (person: CollaboratorInfo, standing: ShareStanding, viewerId: string) =>
  standing.isOwner || (standing.canShare && person.addedBy.some((edge) => edge.type === 'user' && edge.sharer === viewerId))

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Why inviting `userId` to the workspace would change nothing, if it would not. The server takes
 * a grant someone already has without complaint, and a typed name gets past any search's
 * exclusions, so this is asked first.
 */
export const workspaceInviteRefusal = (userId: string, owner: AiChatAuthorInfo, members: readonly CollaboratorInfo[]) => {
  if (sameId(owner.id, userId)) return `${owner.name} owns this workspace.`
  const member = members.find(({ profile }) => sameId(profile.id, userId))
  return member ? `${member.profile.name} is already a member of this workspace.` : undefined
}

/** Access someone has that already covers a gadget, which giving them the gadget would not change. */
export const accessBeyondGadget = ({ profile, access }: CollaboratorInfo) =>
  access.role === 'build' ? `${profile.name} is a member of this workspace, so they can already edit this gadget.` : undefined

/** Why sharing a gadget with `userId` would change nothing, if it would not (see `workspaceInviteRefusal`). */
export const gadgetShareRefusal = (
  userId: string,
  owner: AiChatAuthorInfo,
  collaborators: readonly CollaboratorInfo[],
  gadgetId: WorkpieceId,
) => {
  if (sameId(owner.id, userId)) return `${owner.name} owns this workspace and can already edit this gadget.`
  const existing = collaborators.find(({ profile }) => sameId(profile.id, userId))
  if (!existing) return undefined
  return accessBeyondGadget(existing) ??
    (holdersOf([existing], gadgetId).length > 0 ? `This gadget is already shared with ${existing.profile.name}.` : undefined)
}

/**
 * A gadget's links: the one its dialog turns on and off, and any made before a gadget had only
 * one, which still let people in. Together they are "the" link.
 */
export const gadgetLinksOf = (links: readonly ShareLinkInfo[], gadgetId: WorkpieceId) =>
  links.filter((link) => link.role === 'use' && link.gadgetId === gadgetId).map(({ linkId }) => linkId)

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
  /** They have nothing left of what is taken. Otherwise they still have it some other way. */
  losesAccess: boolean
  /** Those who have it only through them, who lose it too unless kept. */
  dependents: AffectedCollaborator[]
}

export const removalOutcome = (profileId: string, affected: readonly AffectedCollaborator[]): RemovalOutcome => ({
  losesAccess: affected.some(({ profile }) => profile.id === profileId),
  dependents: affected.filter(({ profile }) => profile.id !== profileId),
})

/** Who added someone, by name, as the removal's list says it: "Ada, Grace", or by a link. */
export const invitedBy = (person: AffectedCollaborator, names: ReadonlyMap<string, string>) =>
  person.addedBy.filter((edge) => edge.type === 'user').map((edge) => names.get(edge.sharer) ?? edge.sharer).join(', ') || 'A link'

/** The first word of a name, to speak of someone the way a sentence does: "Ada sees what you see". */
export const firstName = ({ name }: AiChatAuthorInfo) => name.trim().split(/\s+/)[0] || name
