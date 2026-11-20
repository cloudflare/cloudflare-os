import type {
  ContextCollectionMember,
  ContextCollectionMetadata,
  ContextCollectionPermissions,
  ContextCollectionRole,
  ContextCollectionVisibility,
  ContextDocument,
  EnabledCollectionInfo,
} from '../../src/context-types'
import { skillFilesOf } from '../../src/context-types'
import { MANIFEST } from './skillFiles'
import { isValidSkillName } from './skillName'
import { readSkillUploadSource } from './skillUpload'
import type { SkillsBackend } from './SkillStore'

type Collection = { info: EnabledCollectionInfo; documents: Map<string, ContextDocument>; members: ContextCollectionMember[]; everyoneCanView: boolean }

/** What the viewer may do with a collection, from their role in it, as the Context Library works it out for someone who is not an admin. */
const permissionsOf = ({ info }: Collection): ContextCollectionPermissions => {
  const role = info.source === 'private' ? info.membership?.role : undefined
  const canEdit = role === 'owner' || role === 'editor'
  return { canEdit, canShare: canEdit, canManageOwners: role === 'owner', canDelete: role === 'owner' }
}

const isManifest = (path: string) => path === MANIFEST || path.endsWith(`/${MANIFEST}`)

/** The name `SKILL.md` gives its skill, where it is one. */
const skillNameOf = (path: string, body: string) => {
  if (!isManifest(path)) return undefined
  const name = readSkillUploadSource(body).document?.get('name')
  return typeof name === 'string' && isValidSkillName(name) ? name : undefined
}

/**
 * The Context Library's management API in memory, for the tests to read skills from. It keeps
 * documents as the real one does, by path in each collection, and makes a `SKILL.md` a skill as
 * it does, by the name in its frontmatter.
 */
export class MemorySkillsBackend implements SkillsBackend {
  readonly #collections = new Map<string, Collection>()
  #made = 0

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A collection put there as it is, with whose it is. */
  seed(info: Omit<EnabledCollectionInfo, 'id' | 'lastUpdated' | 'description'>, documents: Array<Pick<ContextDocument, 'path' | 'body' | 'contentType'> & { lastUpdated?: Date }>, owner?: string) {
    const id = `collection-${(this.#made += 1)}`
    const role = info.membership?.role
    const collection: Collection = {
      info: { ...info, id, description: '', lastUpdated: this.now() },
      documents: new Map(),
      members: [
        ...(owner ? [{ memberId: 'owner', role: 'owner' as const, displayName: owner, isViewer: false }] : []),
        ...(info.source === 'private' && role ? [{ memberId: 'me', role, isViewer: true }] : []),
      ],
      everyoneCanView: false,
    }
    this.#collections.set(id, collection)
    for (const { lastUpdated, ...document } of documents) this.#put(collection, document.path, { description: '', ...document }, lastUpdated)
    return id
  }

  /** One document as it is kept, for a test to look at. */
  document(collectionId: string, path: string) {
    return this.#collections.get(collectionId)?.documents.get(path)
  }

  #collection(collectionId: string) {
    const found = this.#collections.get(collectionId)
    if (!found) throw new Error('No such collection.')
    return found
  }

  #put(collection: Collection, path: string, { description, body, contentType = 'text/markdown' }: { description: string; body: string; contentType?: string }, lastUpdated = this.now()) {
    const skillName = skillNameOf(path, body)
    const fromManifest = skillName === undefined ? undefined : readSkillUploadSource(body).document?.get('description')
    collection.documents.set(path, {
      path,
      name: path.split('/').at(-1)!,
      description: typeof fromManifest === 'string' ? fromManifest : description,
      contentType,
      body,
      ...(skillName === undefined ? {} : { skillName }),
      lastUpdated,
    })
  }

  listContextDocuments = async (collectionId: string) =>
    [...this.#collection(collectionId).documents.values()].map(({ body: _, ...summary }) => summary)

  listSkillCollections = async () => Promise.all([...this.#collections.values()].map(async (collection) => ({
    ...collection.info,
    documents: await this.listContextDocuments(collection.info.id),
    permissions: permissionsOf(collection),
    owner: collection.info.membership ? collection.members.find(({ role, isViewer }) => role === 'owner' && !isViewer) : undefined,
  })))

  getContextDocument = async (collectionId: string, path: string) => this.#collections.get(collectionId)?.documents.get(path) ?? null

  putContextDocument = async (collectionId: string, path: string, document: { description: string; body: string; contentType?: string }) => {
    this.#put(this.#collection(collectionId), path, document)
  }

  createContextSkill = async (collectionId: string, path: string, document: { description: string; body: string; contentType?: string }) => {
    const collection = this.#collection(collectionId)
    const folder = path.slice(0, -MANIFEST.length)
    if ([...collection.documents.keys()].some((other) => other.startsWith(folder))) throw new Error('A skill is already there.')
    if (!skillNameOf(path, document.body)) throw new Error('Skill frontmatter is invalid.')
    this.#put(collection, path, document)
  }

  deleteContextDocument = async (collectionId: string, path: string) => {
    this.#collection(collectionId).documents.delete(path)
  }

  deleteContextSkill = async (collectionId: string, manifestPath: string) => {
    const { documents } = this.#collection(collectionId)
    const folder = manifestPath.slice(0, -MANIFEST.length)
    for (const path of documents.keys()) if (path.startsWith(folder)) documents.delete(path)
  }

  renameContextSkill = async (collectionId: string, manifestPath: string, newName: string) => {
    const collection = this.#collection(collectionId)
    const folder = manifestPath.slice(0, -MANIFEST.length)
    const moved = `${folder.replace(/[^/]+\/$/, '')}${newName}/`
    // Taken out first, as what is put back under the new name would otherwise be come to again.
    for (const [path, document] of Array.from(collection.documents)) {
      if (!path.startsWith(folder)) continue
      collection.documents.delete(path)
      let { body } = document
      const { document: frontmatter, content } = readSkillUploadSource(body)
      if (path === manifestPath && frontmatter) {
        frontmatter.set('name', newName)
        body = `---\n${frontmatter.toString().trimEnd()}\n---\n${content}`
      }
      this.#put(collection, `${moved}${path.slice(folder.length)}`, { ...document, body })
    }
  }

  /** Copies a skill's documents as they are kept to another collection, then deletes them here, as the real one does in one call. */
  moveContextSkillToCollection = async (fromCollectionId: string, manifestPath: string, toCollectionId: string, directoryPath: string) => {
    if (fromCollectionId === toCollectionId) throw new Error('A skill is moved within its collection with moveContextSkill().')
    const from = this.#editable(fromCollectionId)
    const to = this.#editable(toCollectionId)
    const manifest = from.documents.get(manifestPath)
    if (!manifest?.skillName) throw new Error('It’s no longer there.')
    const folder = manifestPath.slice(0, -MANIFEST.length)
    const moved = `${directoryPath ? `${directoryPath}/` : ''}${folder ? folder.split('/').at(-2) : manifest.skillName}/`
    if ([...to.documents.keys()].some((path) => path.startsWith(moved))) throw new Error('A skill is already there.')
    const skills = [...from.documents.values()].filter(({ skillName }) => skillName !== undefined).map(({ path }) => path)
    const documents = skillFilesOf(manifestPath, skills, [...from.documents.values()])
    for (const document of documents) {
      const path = `${moved}${document.path.slice(folder.length)}`
      to.documents.set(path, { ...document, path })
      from.documents.delete(document.path)
    }
    return `${moved}${MANIFEST}`
  }

  createContextCollection = async (title: string, description: string, visibility: ContextCollectionVisibility): Promise<ContextCollectionMetadata> => {
    const id = this.seed({ title, source: visibility, membership: visibility === 'private' ? { role: 'owner', shared: false } : undefined }, [])
    const { info } = this.#collection(id)
    info.description = description
    return { id, title, description, visibility, created: info.lastUpdated, lastUpdated: info.lastUpdated, documentCount: 0, content: { source: 'web' } }
  }

  updateContextCollection = async (collectionId: string, { title, description }: { title?: string; description?: string }) => {
    const collection = this.#editable(collectionId)
    collection.info = { ...collection.info, title: title ?? collection.info.title, description: description ?? collection.info.description, lastUpdated: this.now() }
  }

  deleteContextCollection = async (collectionId: string) => {
    if (!permissionsOf(this.#collection(collectionId)).canDelete) throw new Error('Only an owner can delete it.')
    this.#collections.delete(collectionId)
  }

  getContextCollectionSharing = async (collectionId: string) => {
    const { members, everyoneCanView } = this.#collection(collectionId)
    return { members: [...members], everyoneCanView, hasOwner: members.some(({ role }) => role === 'owner') }
  }

  /** Shares with whoever a ticket from `asApi().createGatekeeperUserSelection` names, by the id it was made for. */
  shareContextCollection = async (collectionId: string, ticket: string, role: ContextCollectionRole) => {
    const collection = this.#editable(collectionId)
    const userId = ticket.replace(/^ticket:/, '')
    collection.members = [...collection.members.filter(({ memberId }) => memberId !== userId), { memberId: userId, role, displayName: userId, isViewer: false }]
    this.#markShared(collection)
  }

  setContextCollectionMemberRole = async (collectionId: string, memberId: string, role: ContextCollectionRole) => {
    const collection = this.#editable(collectionId)
    collection.members = collection.members.map((member) => (member.memberId === memberId ? { ...member, role } : member))
  }

  removeContextCollectionMember = async (collectionId: string, memberId: string) => {
    const collection = this.#editable(collectionId)
    collection.members = collection.members.filter((member) => member.memberId !== memberId)
    this.#markShared(collection)
  }

  leaveContextCollection = async (collectionId: string) => {
    const { members } = this.#collection(collectionId)
    const me = members.find(({ isViewer }) => isViewer)
    if (me?.role === 'owner' && !members.some((other) => other !== me && other.role === 'owner')) throw new Error('The last owner can’t leave.')
    this.#collections.delete(collectionId)
  }

  setContextCollectionEveryoneCanView = async (collectionId: string, everyoneCanView: boolean) => {
    const collection = this.#editable(collectionId)
    collection.everyoneCanView = everyoneCanView
    this.#markShared(collection)
  }

  #editable(collectionId: string) {
    const collection = this.#collection(collectionId)
    if (!permissionsOf(collection).canEdit) throw new Error('Collection not found or you don’t have access.')
    return collection
  }

  /** Whether anyone besides the viewer can read it, as the library lists it. */
  #markShared(collection: Collection) {
    const { membership } = collection.info
    if (!membership) return
    const shared = collection.everyoneCanView || collection.members.some(({ isViewer }) => !isViewer)
    collection.info = { ...collection.info, membership: { ...membership, shared } }
  }
}
