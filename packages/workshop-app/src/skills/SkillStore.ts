import { stringify } from 'yaml'
import type {
  ContextApi,
  ContextCollectionPermissions,
  ContextCollectionRole,
  ContextCollectionSharing,
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from '@gadgets/gatekeeper-context/src/context-types'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { MANIFEST, type SkillFile } from './skillFiles'
import { humanizeSkillName, isValidSkillName, skillNameFromTitle } from './skillName'
import { readSkillUploadSource, writeSkillUploadMetadata, type SkillUploadCandidate } from './skillUpload'

/**
 * A skill: instructions the assistant loads when a task calls for them, with whatever files they
 * refer to. They are one flat list: the collection a skill is kept in is a tag on it.
 */
export type Skill = {
  /** Where it is kept: its collection, then its `SKILL.md`'s path there (`<collection>/<path>`), which is also what a workspace's slash command for it is known by. */
  id: string
  /** What it is called, as it is read: "Summarize meeting notes". */
  name: string
  /** What it is for, which is what the assistant goes by to load it. */
  description: string
  /** What it is filed under, if anything: the collection it is in, but for the user's own first one. */
  tag?: string
  /** The collection it is kept in (`SkillCollection.id`). */
  collectionId: string
  /** The user may change it: its collection is theirs, or was shared with them to edit. */
  editable: boolean
  /** Whose it is: the user's own, somebody's who shared it with them, or the deployment's, for everyone. */
  source: { kind: 'mine' } | { kind: 'shared'; by: string } | { kind: 'organization' }
  updated: Date
  /** The assistant may load it on its own, when a request matches what it is for. */
  autoUse: boolean
  /**
   * Its files: `SKILL.md` first, which has its name and what it is for over its instructions, then
   * the rest by path. Only once they have been read (`SkillStore.open`), which listing them does not.
   */
  files?: SkillFile[]
}

/**
 * A collection of skills, as the Context Library keeps them: what the skills' tags name, with who
 * has it. It is shared whole, never one skill of it.
 */
export type SkillCollection = {
  id: string
  title: string
  description: string
  /** Whose it is: the user's own (which they may have shared), somebody's who shared it with them, or the organization's. */
  source: Skill['source']
  /** The user's role in it, for one that is not the organization's. */
  role?: ContextCollectionRole
  /** Somebody besides the user can read it: shared with someone, or with everyone. */
  shared: boolean
  /** What the user may do with it, as the Context Library says; nothing, where it could not say. */
  permissions: ContextCollectionPermissions
  /** It is the user's own first one, whose skills have no tag. */
  untagged: boolean
  /** How many skills are in it. */
  skillCount: number
  updated: Date
}

/** A skill as it is written from nothing: what it is called, what it is for, and a tag or a collection to put it in, if any. */
export type WrittenSkill = { name: string; description: string; tag?: string; collectionId?: string }

/** The skills, as far as they have been read. */
export type SkillsState =
  | { status: 'loading' }
  /** The user has no Context Library account to keep skills in: with `canTurnOn`, the deployment offers them one. */
  | { status: 'off'; canTurnOn: boolean }
  | { status: 'failed'; message: string }
  | { status: 'ready'; skills: Skill[]; collections: SkillCollection[] }

/** The part of the Context Library's management API (`ContextApi`) the skills are read and written through. */
export type SkillsBackend = Pick<
  ContextApi,
  | 'listEnabledContextCollections'
  | 'listContextDocuments'
  | 'getContextDocument'
  | 'putContextDocument'
  | 'createContextSkill'
  | 'deleteContextDocument'
  | 'deleteContextSkill'
  | 'renameContextSkill'
  | 'createContextCollection'
  | 'updateContextCollection'
  | 'deleteContextCollection'
  | 'getContextCollectionPermissions'
  | 'getContextCollectionSharing'
  | 'shareContextCollection'
  | 'setContextCollectionMemberRole'
  | 'removeContextCollectionMember'
  | 'leaveContextCollection'
  | 'setContextCollectionEveryoneCanView'
>

/** The part of the user's API that opens the Context Library, or turns it on. */
export type SkillsApi = Pick<AuthenticatedApi, 'getGatekeeperApp' | 'listAddableGatekeepers' | 'provisionAmbientAccount' | 'createGatekeeperUserSelection'>

/** The Context Library's gatekeeper, whose management app holds the user's skills. */
export const SKILLS_APP = 'context'

/** The collection a skill with no tag is kept in, made for the first one the user writes. */
export const UNTAGGED = 'My skills'

const MARKDOWN = 'text/markdown'
const LOADING: SkillsState = { status: 'loading' }
const NONE: Skill[] = []
const NO_COLLECTIONS: SkillCollection[] = []
/** What may be done with a collection whose permissions could not be read: nothing, as the Context Library's own app has it. */
const READ_ONLY: ContextCollectionPermissions = { canEdit: false, canShare: false, canManageOwners: false, canDelete: false }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** `SKILL.md` for a skill written from nothing: its name and what it is for, over its instructions. */
export const manifestOf = (name: string, description: string, instructions = '') => `---\n${stringify({ name, description }).trimEnd()}\n---\n\n${instructions}`

/**
 * `SKILL.md` with another name and description, keeping whatever else it says of itself and its
 * instructions as they are. Done again it gives the same, so a skill renamed twice does not grow.
 */
const withMetadata = (body: string, name: string, description: string) => {
  const { document, content } = readSkillUploadSource(body)
  if (document === null) return writeSkillUploadMetadata(body, name, description)
  document.set('name', name)
  document.set('description', description)
  return `---\n${document.toString().trimEnd()}\n---\n\n${content.replace(/^(?:[ \t]*\r?\n)+/, '')}`
}

/** What `SKILL.md` says the skill is for, where it says so in words. */
const descriptionOf = (body: string) => {
  const description = readSkillUploadSource(body).document?.get('description')
  return typeof description === 'string' ? description.trim() : undefined
}

/**
 * What a skill is called, from the name `SKILL.md` gives it, which is in lowercase with hyphens:
 * the title it was given here, while that is still what the name was made from, and otherwise the
 * name with its words capitalized.
 */
const titleFor = (metadataName: string, title: string | undefined) =>
  title !== undefined && skillNameFromTitle(title) === metadataName ? title : humanizeSkillName(metadataName)

const inOrder = (files: SkillFile[]) =>
  files.toSorted((a, b) => Number(b.path === MANIFEST) - Number(a.path === MANIFEST) || a.path.localeCompare(b.path))

/** Where a skill is: its collection and its `SKILL.md`'s path, and the folder that holds its files (`''` at the top). */
const placeOf = (id: string) => {
  const slash = id.indexOf('/')
  if (slash <= 0 || !id.endsWith(MANIFEST)) return undefined
  const path = id.slice(slash + 1)
  return { collectionId: id.slice(0, slash), path, folder: path.slice(0, -MANIFEST.length) }
}

const parentOf = (folder: string) => folder.replace(/[^/]+\/$/, '')

/** A collection of the user's own, which they may write to. */
const isOwn = (info: EnabledCollectionInfo) => info.source === 'private' && info.membership?.role === 'owner'

/** Whose a collection is: the user's own, somebody's who shared it with them (by the name they had then), or the organization's. */
const sourceOf = (info: EnabledCollectionInfo, by: string | undefined): Skill['source'] =>
  isOwn(info) ? { kind: 'mine' } : info.source === 'public' ? { kind: 'organization' } : { kind: 'shared', by: by ?? 'Someone' }

/** The user's own collection that their untagged skills are in. */
const isUntagged = (info: EnabledCollectionInfo) => isOwn(info) && info.title === UNTAGGED

const collectionOf = (info: EnabledCollectionInfo, by: string | undefined, permissions: ContextCollectionPermissions, skillCount: number): SkillCollection => ({
  id: info.id,
  title: info.title,
  description: info.description,
  source: sourceOf(info, by),
  role: info.membership?.role,
  shared: info.membership?.shared ?? false,
  permissions,
  untagged: isUntagged(info),
  skillCount,
  updated: new Date(info.lastUpdated),
})

const RANK = { mine: 0, shared: 1, organization: 2 } as const

/** The user's own first, `My skills` ahead of the rest, then those shared with them, then the organization's, each by name. */
export const collectionOrder = (a: SkillCollection, b: SkillCollection) =>
  RANK[a.source.kind] - RANK[b.source.kind] || Number(b.untagged) - Number(a.untagged) || a.title.localeCompare(b.title)

/** The skills a collection's documents make, each with the paths of its files, within its folder. */
const skillsIn = (documents: ContextDocumentSummary[]) => {
  const manifests = documents.filter((document) => document.skillName !== undefined && (document.path === MANIFEST || document.path.endsWith(`/${MANIFEST}`)))
  const folders = manifests.map(({ path }) => path.slice(0, -MANIFEST.length))
  return manifests.map((manifest) => {
    const folder = manifest.path.slice(0, -MANIFEST.length)
    // A skill in a folder of its own within this one has its files to itself.
    const nested = folders.filter((other) => other !== folder && other.startsWith(folder))
    const files = documents.filter(({ path }) => path.startsWith(folder) && !nested.some((other) => path.startsWith(other)))
    return { manifest, folder, files }
  })
}

/**
 * The user's skills and their files, and what can be done to them, kept in the Context Library
 * (`gatekeeper-context`) through its management API, which the Workshop hands out as its app's
 * (`getGatekeeperApp`). Every collection the user can read is listed, the skills in each one flat,
 * the collection as a tag; a skill's files are read only once it is opened (`open`). The
 * collections are listed too (`collections`), as they are what is made, shared and left whole.
 *
 * A skill's name and what it is for are kept twice, on the skill as the Context Library lists it,
 * and in its `SKILL.md`, which is what the assistant reads: a change to either is made to the
 * other. What changes a skill resolves once it is kept and the list has been read again, and
 * rejects with why it was not, for whoever asked to say so.
 *
 * Whether the assistant may load one on its own is not kept anywhere yet, so it lasts the visit.
 */
export class SkillStore {
  #state: SkillsState = LOADING
  readonly #listeners = new Set<() => void>()
  #api: SkillsApi | undefined
  #backend: Promise<(SkillsBackend & Partial<Disposable>) | null> | undefined
  #collections: EnabledCollectionInfo[] = []
  #run = 0
  // What is known here that the Context Library does not say: the files read of each skill, the
  // title each was given, and whether it may be loaded on its own, by its id.
  readonly #files = new Map<string, SkillFile[]>()
  readonly #titles = new Map<string, string>()
  readonly #autoUse = new Map<string, boolean>()

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  getSnapshot = () => this.#state

  /** The skills, once read; the same array until one of them changes. */
  get skills() {
    return this.#state.status === 'ready' ? this.#state.skills : NONE
  }

  get(id: string) {
    return this.skills.find((skill) => skill.id === id)
  }

  /** The collections the user can read, once read: theirs first, then those shared with them, then the organization's. */
  get collections() {
    return this.#state.status === 'ready' ? this.#state.collections : NO_COLLECTIONS
  }

  collection(id: string) {
    return this.collections.find((collection) => collection.id === id)
  }

  /**
   * Reads the skills through `api`, and keeps them from then on. Another `api`, as a new connection
   * brings, reads them all again over it, with what was read before shown meanwhile.
   */
  connect(api: SkillsApi) {
    if (api === this.#api) return
    this.#api = api
    void this.#backend?.then((backend) => backend?.[Symbol.dispose]?.(), () => {})
    this.#backend = undefined
    void this.reload()
  }

  /** Reads the list again, as after something was changed elsewhere. */
  reload = async () => {
    const run = ++this.#run
    try {
      const backend = await this.#open()
      if (run !== this.#run) return
      if (!backend) {
        const addable = await this.#needApi().listAddableGatekeepers()
        if (run === this.#run) this.#publish({ status: 'off', canTurnOn: addable.some(({ id }) => id === SKILLS_APP) })
        return
      }
      const infos = await backend.listEnabledContextCollections()
      const read = await Promise.all(infos.map(async (info) => {
        const [documents, by, permissions] = await Promise.all([
          backend.listContextDocuments(info.id),
          this.#sharedBy(backend, info),
          // A collection whose permissions cannot be read is only read, never changed, from here.
          backend.getContextCollectionPermissions(info.id).catch(() => READ_ONLY),
        ])
        const skills = skillsIn(documents).map(({ manifest }) => this.#skillOf(info, manifest, by, permissions.canEdit))
        return { skills, collection: collectionOf(info, by, permissions, skills.length) }
      }))
      if (run !== this.#run) return
      this.#collections = infos
      this.#publish({
        status: 'ready',
        // The files as they are now, which a skill opened while the list was read may have had read again.
        skills: read.flatMap(({ skills }) => skills.map((skill) => ({ ...skill, files: this.#files.get(skill.id) }))),
        collections: read.map(({ collection }) => collection).toSorted(collectionOrder),
      })
    } catch (error) {
      // What was read stays up when reading it again fails.
      if (run === this.#run && this.#state.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    }
  }

  /** Gives the user a Context Library account to keep skills in, where the deployment offers one. */
  turnOn = async () => {
    await this.#needApi().provisionAmbientAccount(SKILLS_APP)
    this.#backend = undefined
    await this.reload()
  }

  /** Reads a skill's files, for it to be shown whole. */
  async open(id: string) {
    const place = placeOf(id)
    if (!place) return
    const backend = await this.#ready()
    const listed = skillsIn(await backend.listContextDocuments(place.collectionId)).find(({ manifest }) => manifest.path === place.path)
    if (!listed) return
    const files = await Promise.all(listed.files.map(async ({ path }) => {
      const document = await backend.getContextDocument(place.collectionId, path)
      return document && { path: path.slice(place.folder.length), contentType: document.contentType, body: document.body }
    }))
    this.#files.set(id, inOrder(files.flatMap((file) => file ?? [])))
    this.#update()
  }

  /** Whether a skill can be called `title`: a name in letters and numbers can be made of it. */
  static canBeCalled(title: string) {
    return isValidSkillName(skillNameFromTitle(title))
  }

  /** Adds a skill written from nothing, with a `SKILL.md` that says what it is, in the collection its tag names. Gives its id. */
  async add({ name, description, tag, collectionId: into }: WrittenSkill): Promise<string> {
    const metadataName = this.#nameFor(name)
    const backend = await this.#ready()
    const collectionId = into ?? await this.#collectionFor(backend, tag)
    const path = `${metadataName}/${MANIFEST}`
    await backend.createContextSkill(collectionId, path, { description, body: manifestOf(metadataName, description, `# ${name}\n\n`) })
    const id = `${collectionId}/${path}`
    this.#titles.set(id, name)
    await this.reload()
    return id
  }

  /**
   * Adds the skills made out of files that were chosen (`prepareSkillUploads`), each with its
   * `SKILL.md` and the files that came with it, untagged, or in the collection `into`. One whose file says nothing of its name
   * or what it is for, or nothing that can be gone by, is given both from what it was called.
   * Gives their ids.
   */
  async addUploads(candidates: SkillUploadCandidate[], into?: string): Promise<string[]> {
    if (candidates.length === 0) return []
    const backend = await this.#ready()
    const collectionId = into ?? await this.#collectionFor(backend, undefined)
    const ids: string[] = []
    try {
      for (const candidate of candidates) {
        const fromLabel = skillNameFromTitle(candidate.label)
        const name = isValidSkillName(candidate.name) ? candidate.name : isValidSkillName(fromLabel) ? fromLabel : 'untitled-skill'
        const description = candidate.description.trim() || `Instructions for ${humanizeSkillName(name)}.`
        await backend.createContextSkill(collectionId, `${name}/${MANIFEST}`, { description, body: writeSkillUploadMetadata(candidate.manifestBody, name, description) })
        for (const file of candidate.supportingFiles) {
          await backend.putContextDocument(collectionId, `${name}/${file.path}`, { description: '', body: file.body, contentType: file.contentType })
        }
        ids.push(`${collectionId}/${name}/${MANIFEST}`)
      }
    } finally {
      // Those made before one could not be are listed, as they are there.
      await this.reload()
    }
    return ids
  }

  /** Calls a skill something else, which moves it to a folder of that name. Gives its id from then on. */
  async rename(id: string, title: string): Promise<string> {
    const skill = this.#need(id)
    const place = this.#place(id)
    const metadataName = this.#nameFor(title)
    if (metadataName === skillNameFromTitle(skill.name)) {
      this.#titles.set(id, title)
      this.#update()
      return id
    }
    const backend = await this.#ready()
    await backend.renameContextSkill(place.collectionId, place.path, metadataName)
    const moved = `${place.collectionId}/${parentOf(place.folder)}${metadataName}/${MANIFEST}`
    this.#titles.set(moved, title)
    this.#forget(id, moved)
    await this.reload()
    return moved
  }

  /** Says something else of what a skill is for, in its `SKILL.md` too. */
  async describe(id: string, description: string) {
    const skill = this.#need(id)
    const place = this.#place(id)
    const backend = await this.#ready()
    const manifest = await backend.getContextDocument(place.collectionId, place.path)
    if (!manifest) throw new Error('It’s no longer there.')
    await backend.putContextDocument(place.collectionId, place.path, {
      description,
      body: withMetadata(manifest.body, skillNameFromTitle(skill.name), description),
      contentType: MARKDOWN,
    })
    await this.#afterChange(id)
  }

  /**
   * Files a skill under `tag`, or under nothing, which moves it, files and all, to the user's
   * collection of that name, made for it where they have none. Gives its id from then on.
   */
  async setTag(id: string, tag: string | undefined): Promise<string> {
    const place = this.#place(id)
    const backend = await this.#ready()
    const into = await this.#collectionFor(backend, tag?.trim() || undefined)
    if (into === place.collectionId) return id
    if (!this.#files.has(id)) await this.open(id)
    const files = this.#files.get(id) ?? []
    const manifest = files.find(({ path }) => path === MANIFEST)
    if (!manifest) throw new Error('It’s no longer there.')
    // A collection has no way to give another a skill, so it is made again there, then deleted here.
    const path = `${place.folder}${MANIFEST}`
    await backend.createContextSkill(into, path, { description: descriptionOf(manifest.body) ?? '', body: manifest.body, contentType: manifest.contentType })
    for (const file of files.filter((each) => each !== manifest)) {
      await backend.putContextDocument(into, `${place.folder}${file.path}`, { description: '', body: file.body, contentType: file.contentType })
    }
    await backend.deleteContextSkill(place.collectionId, place.path)
    const moved = `${into}/${path}`
    this.#forget(id, moved)
    await this.reload()
    return moved
  }

  setAutoUse(id: string, autoUse: boolean) {
    this.#autoUse.set(id, autoUse)
    this.#update()
  }

  /**
   * Puts files in a skill, each in place of the one at its path, if there is one. A `SKILL.md`
   * among them is the skill's own from then on, so the skill is called and is for what it says.
   */
  async putFiles(id: string, files: SkillFile[]) {
    const place = this.#place(id)
    const backend = await this.#ready()
    for (const file of files) await this.#write(backend, place, file)
    await this.#afterChange(id)
  }

  /** Keeps what was written in one of a skill's files. Written in `SKILL.md`, the skill is for what it says. */
  async saveFile(id: string, path: string, body: string) {
    const place = this.#place(id)
    const contentType = this.#files.get(id)?.find((file) => file.path === path)?.contentType ?? MARKDOWN
    await this.#write(await this.#ready(), place, { path, contentType, body })
    await this.#afterChange(id)
  }

  /** Takes a file out of a skill. Not its `SKILL.md`, without which it is not one. */
  async removeFile(id: string, path: string) {
    if (path === MANIFEST) return
    const place = this.#place(id)
    await (await this.#ready()).deleteContextDocument(place.collectionId, `${place.folder}${path}`)
    await this.#afterChange(id)
  }

  /** Deletes a skill, with its files. */
  async remove(id: string) {
    const place = this.#place(id)
    await (await this.#ready()).deleteContextSkill(place.collectionId, place.path)
    this.#forget(id)
    await this.reload()
  }

  /** Makes a collection of the user's own, empty, to put skills in and share. Gives its id. */
  async addCollection(title: string, description: string): Promise<string> {
    const name = title.trim()
    if (!name) throw new Error('A collection needs a name.')
    const made = await (await this.#ready()).createContextCollection(name, description.trim(), 'private')
    await this.reload()
    return made.id
  }

  /** Calls a collection something else, or says something else of it. Its skills' tag is its name, so they are filed under the new one. */
  async updateCollection(id: string, change: { title?: string; description?: string }) {
    if (change.title !== undefined && !change.title.trim()) throw new Error('A collection needs a name.')
    await (await this.#ready()).updateContextCollection(id, { title: change.title?.trim(), description: change.description?.trim() })
    await this.reload()
  }

  /** Deletes a collection, with every skill in it, for everyone who has it. */
  async removeCollection(id: string) {
    await (await this.#ready()).deleteContextCollection(id)
    this.#forgetIn(id)
    await this.reload()
  }

  /** Gives up the user's place in a collection shared with them, which leaves their list with its skills. */
  async leaveCollection(id: string) {
    await (await this.#ready()).leaveContextCollection(id)
    this.#forgetIn(id)
    await this.reload()
  }

  /** Who has a collection, read as it is now. */
  async sharing(id: string): Promise<ContextCollectionSharing> {
    return (await this.#ready()).getContextCollectionSharing(id)
  }

  /**
   * Shares a collection with someone in the deployment, by their user id, as the Context Library's
   * own app does: the Workshop vouches for who they are with a ticket only the Context Library can
   * redeem, so no account is ever named from here.
   */
  async share(id: string, userId: string, role: ContextCollectionRole) {
    const backend = await this.#ready()
    const selection = await this.#needApi().createGatekeeperUserSelection(SKILLS_APP, userId)
    if (!selection) throw new Error('There’s nobody here by that name, other than you.')
    await backend.shareContextCollection(id, selection.ticket, role)
    await this.reload()
  }

  async setMemberRole(id: string, memberId: string, role: ContextCollectionRole) {
    await (await this.#ready()).setContextCollectionMemberRole(id, memberId, role)
    await this.reload()
  }

  async removeMember(id: string, memberId: string) {
    await (await this.#ready()).removeContextCollectionMember(id, memberId)
    await this.reload()
  }

  /** Lets everyone in the deployment use a collection's skills, without it being put in their list, or stops. */
  async setEveryoneCanView(id: string, everyone: boolean) {
    await (await this.#ready()).setContextCollectionEveryoneCanView(id, everyone)
    await this.reload()
  }

  /** Lets go of what was known here of the skills in a collection that is gone. */
  #forgetIn(collectionId: string) {
    for (const skill of this.skills) if (skill.collectionId === collectionId) this.#forget(skill.id)
  }

  #write(backend: SkillsBackend, place: NonNullable<ReturnType<typeof placeOf>>, file: SkillFile) {
    const manifest = file.path === MANIFEST
    return backend.putContextDocument(place.collectionId, `${place.folder}${file.path}`, {
      // What the skill is for, which the Context Library reads from `SKILL.md` too.
      description: manifest ? descriptionOf(file.body) ?? '' : '',
      body: file.body,
      contentType: file.contentType,
    })
  }

  /** Reads the list again, and the skill's files if they had been. */
  async #afterChange(id: string) {
    await Promise.all([this.reload(), this.#files.has(id) ? this.open(id) : undefined])
  }

  /** Lets go of what was known of a skill here, or carries it to where it has moved. */
  #forget(id: string, movedTo?: string) {
    const [title, autoUse] = [this.#titles.get(id), this.#autoUse.get(id)]
    this.#files.delete(id)
    this.#titles.delete(id)
    this.#autoUse.delete(id)
    if (movedTo === undefined) return
    // A new name is its own, which `rename` has given it already.
    if (title !== undefined && !this.#titles.has(movedTo)) this.#titles.set(movedTo, title)
    if (autoUse !== undefined) this.#autoUse.set(movedTo, autoUse)
  }

  #nameFor(title: string) {
    const name = skillNameFromTitle(title)
    if (!isValidSkillName(name)) throw new Error('A skill’s name needs letters or numbers in it, and can’t be longer than 64 characters.')
    return name
  }

  #need(id: string) {
    const skill = this.get(id)
    if (!skill) throw new Error('It’s no longer there.')
    return skill
  }

  #place(id: string) {
    const place = placeOf(id)
    if (!place) throw new Error('It’s no longer there.')
    return place
  }

  #needApi() {
    if (!this.#api) throw new Error('Not connected.')
    return this.#api
  }

  // The frame's `ui` is typed by each gatekeeper, not by the Workshop's API: the Context Library's
  // is `ContextApi`, which it exports for exactly this. Its page is not shown here.
  #open() {
    this.#backend ??= this.#needApi().getGatekeeperApp(SKILLS_APP).then((frame) => (frame ? (frame.ui as unknown as SkillsBackend & Partial<Disposable>) : null))
    // Tried again next time, rather than failing from then on.
    this.#backend.catch(() => {
      this.#backend = undefined
    })
    return this.#backend
  }

  async #ready() {
    const backend = await this.#open()
    if (!backend) throw new Error('Skills aren’t turned on for you.')
    return backend
  }

  /** The user's own collection that `tag` names, or for none, the one untagged skills are in; made for it where there is none. */
  async #collectionFor(backend: SkillsBackend, tag: string | undefined) {
    const title = tag ?? UNTAGGED
    const own = this.#collections.find((info) => isOwn(info) && info.title === title)
    if (own) return own.id
    const made = await backend.createContextCollection(title, tag === undefined ? 'Skills I wrote for the assistant.' : '', 'private')
    this.#collections = [...this.#collections, { id: made.id, title, description: made.description, source: 'private', lastUpdated: made.lastUpdated, membership: { role: 'owner', shared: false } }]
    return made.id
  }

  /** Who shared a collection with the user, by the name they had then; none for one that is theirs or everyone's. */
  async #sharedBy(backend: SkillsBackend, info: EnabledCollectionInfo) {
    if (info.source !== 'private' || info.membership?.role === 'owner') return undefined
    const sharing = await backend.getContextCollectionSharing(info.id).catch(() => undefined)
    return sharing?.members.find(({ role, isViewer }) => role === 'owner' && !isViewer)?.displayName ?? 'Someone'
  }

  #skillOf(info: EnabledCollectionInfo, manifest: ContextDocumentSummary, by: string | undefined, editable: boolean): Skill {
    const id = `${info.id}/${manifest.path}`
    return {
      id,
      name: titleFor(manifest.skillName!, this.#titles.get(id)),
      description: manifest.description,
      tag: isUntagged(info) ? undefined : info.title,
      collectionId: info.id,
      editable,
      source: sourceOf(info, by),
      updated: new Date(manifest.lastUpdated),
      autoUse: this.#autoUse.get(id) ?? true,
      files: this.#files.get(id),
    }
  }

  /** The skills again, with what is known of each here. */
  #update() {
    if (this.#state.status !== 'ready') return
    this.#publish({
      ...this.#state,
      skills: this.#state.skills.map((skill) => {
        const files = this.#files.get(skill.id)
        const autoUse = this.#autoUse.get(skill.id) ?? true
        const metadataName = skillNameFromTitle(skill.name)
        const name = titleFor(metadataName, this.#titles.get(skill.id) ?? skill.name)
        return files === skill.files && autoUse === skill.autoUse && name === skill.name ? skill : { ...skill, files, autoUse, name }
      }),
    })
  }

  #publish(state: SkillsState) {
    this.#state = state
    for (const listener of this.#listeners) listener()
  }
}
