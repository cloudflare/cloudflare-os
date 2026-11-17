import type {
  AffectedCollaborator,
  AiChatAuthorInfo,
  CollaboratorInfo,
  CollaboratorRole,
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

/** What someone has, the server's way: a collaborator with no role was added before roles, when everyone could edit. */
export const roleOf = ({ role }: { role?: CollaboratorRole }): CollaboratorRole => role ?? 'build'

/**
 * Whether the viewer may take someone's access away: the owner may take anyone's, and anyone else
 * who can share only what they gave themselves.
 */
export const canChange = (person: CollaboratorInfo, standing: ShareStanding, viewerId: string) =>
  standing.isOwner || (standing.canShare && person.addedBy.some((edge) => edge.type === 'user' && edge.sharer === viewerId))

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Why inviting `userId` with `role` would change nothing, if it would not. The server takes a
 * grant someone already has without complaint, and a typed name gets past any search's
 * exclusions, so this is asked first. Someone who can only use it may still be let edit.
 */
export const inviteRefusal = (userId: string, role: CollaboratorRole, owner: AiChatAuthorInfo, collaborators: readonly CollaboratorInfo[]) => {
  if (sameId(owner.id, userId)) return `${owner.name} owns this workspace.`
  const existing = collaborators.find(({ profile }) => sameId(profile.id, userId))
  if (!existing) return undefined
  const has = roleOf(existing)
  if (has === 'build') return `${existing.profile.name} can already edit this workspace.`
  return role === 'use' ? `${existing.profile.name} can already use this workspace.` : undefined
}

/**
 * The workspace's links: the server keeps any number, made here or elsewhere, and together they
 * are "the" link. It lets people edit if any of them does, else only use (`role`), and the one of
 * them to copy is one that does what that says (`shown`); undefined where there is none.
 */
export const workspaceLinksOf = (links: readonly ShareLinkInfo[]): { linkIds: string[]; role: CollaboratorRole; shown: string } | undefined => {
  if (links.length === 0) return undefined
  const editing = links.find((link) => roleOf(link) === 'build')
  return { linkIds: links.map(({ linkId }) => linkId), role: editing ? 'build' : 'use', shown: (editing ?? links[0]!).linkId }
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
   * What is left to them: nothing, only using it (they were let edit by the viewer, and use it
   * through someone else), or all they had, as they have it some other way too.
   */
  left: 'nothing' | 'use' | 'unchanged'
  /** Those who have it only through them, who lose it too unless kept. */
  dependents: AffectedCollaborator[]
}

export const removalOutcome = (profileId: string, affected: readonly AffectedCollaborator[]): RemovalOutcome => {
  const target = affected.find(({ profile }) => profile.id === profileId)
  return {
    left: !target ? 'unchanged' : target.newRole === null ? 'nothing' : 'use',
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

/** Names as a sentence lists them: "Google", "Google and Slack", "Google, Slack and GitHub". */
export const listed = (names: readonly string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
