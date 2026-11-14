import type {
  ContextApi,
  ContextCollectionMember,
  ContextCollectionPermissions,
  ContextCollectionRole,
  ContextDocumentSummary,
  EnabledCollectionInfo,
} from '@gadgets/gatekeeper-context/src/context-types'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { MAX_SKILL_DESCRIPTION, isSkillName, newSkillManifest, readSkillManifest, skillNameFor, updateSkillManifest } from './skillManifest'

/** The Skills gatekeeper's id, whose management app holds the user's skills. */
export const SKILLS_APP = 'context'

/** One skill, as listed: enough to show and find it without reading what it says. */
export type Skill = {
  /** Where it is: its collection and its manifest's path, as one string (`<collection>/<path>`). */
  id: string
  collectionId: string
  /** Its manifest: `meeting-brief/SKILL.md`. */
  path: string
  /** Its name, as the agent and slash commands know it: `meeting-brief`. */
  name: string
  description: string
  lastUpdated: Date
}

/** A collection of skills, as the Skills tab groups them. */
export type SkillCollection = {
  id: string
  title: string
  /** An emoji, when it has one. */
  icon?: string
  /** `mine`: the viewer owns it. `shared`: someone gave it to them. `everyone`: the deployment's. */
  kind: 'mine' | 'shared' | 'everyone'
  /** Whether anyone besides the viewer can read it. */
  shared: boolean
  role?: ContextCollectionRole
  permissions: ContextCollectionPermissions
  skills: Skill[]
}

/** A skill read whole, to show and to change. */
export type SkillContent = Skill & {
  instructions: string
  /** The manifest as stored, which a change is made to so that what it holds besides is kept. */
  body: string
}

export type SkillsSnapshot =
  | { status: 'loading' }
  /** The user has no Skills: with `canTurnOn`, the deployment offers them and one click adds them. */
  | { status: 'off'; canTurnOn: boolean }
  | { status: 'failed'; message: string }
  | { status: 'ready'; collections: SkillCollection[]; isAdmin: boolean }

/** A person a collection is shared with. */
export type SkillMember = ContextCollectionMember

/** The parts of the user's API the skills use. */
export type SkillsApi = Pick<AuthenticatedApi, 'getGatekeeperApp' | 'listAddableGatekeepers' | 'provisionAmbientAccount' | 'createGatekeeperUserSelection'>

/** The management API, and the lease on it. */
export type SkillsUi = ContextApi & Partial<Disposable>

const LOADING: SkillsSnapshot = { status: 'loading' }
const MY_SKILLS = 'My skills'
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The skill an id names, as its parts. */
export const parseSkillId = (id: string) => {
  const slash = id.indexOf('/')
  return slash > 0 && slash < id.length - 1 ? { collectionId: id.slice(0, slash), path: id.slice(slash + 1) } : undefined
}

const skillOf = (collectionId: string, document: ContextDocumentSummary): Skill | undefined =>
  document.skillName === undefined
    ? undefined
    : {
        id: `${collectionId}/${document.path}`,
        collectionId,
        path: document.path,
        name: document.skillName,
        description: document.description,
        lastUpdated: new Date(document.lastUpdated),
      }

const kindOf = (info: EnabledCollectionInfo): SkillCollection['kind'] =>
  info.source === 'public' ? 'everyone' : info.membership?.role === 'owner' ? 'mine' : 'shared'

// The order the tab shows them in: the viewer's own, then what was shared with them, then the
// deployment's, each by title.
const ORDER: Record<SkillCollection['kind'], number> = { mine: 0, shared: 1, everyone: 2 }
const byPlace = (a: SkillCollection, b: SkillCollection) => ORDER[a.kind] - ORDER[b.kind] || a.title.localeCompare(b.title)

/**
 * The user's skills, from the Skills gatekeeper's management API (`ContextApi`): every collection
 * they can read, the skills in each, and what they may do with them. Observable through
 * `subscribe`/`getSnapshot`. It reads nothing until something wants it (`retain`), then keeps what
 * it has; `restart()` reads it all again on a new connection, keeping what is shown meanwhile.
 *
 * What changes a skill or a collection reads the list again once it is done, and rejects with why
 * it was not done, for whoever asked to say so.
 */
export class SkillsLibrary {
  #snapshot: SkillsSnapshot = LOADING
  #listeners = new Set<() => void>()
  #ui: SkillsUi | undefined
  #run = 0
  #wanted = 0
  #started = false

  constructor(private readonly api: () => SkillsApi) {}

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => void this.#listeners.delete(listener)
  }

  getSnapshot = () => this.#snapshot

  /** Something shows the skills: read them, if they are not yet. Returns the way to let them go. */
  retain = () => {
    this.#wanted++
    if (!this.#started) this.start()
    return () => {
      this.#wanted--
    }
  }

  start() {
    this.#started = true
    const run = ++this.#run
    void this.#load(run)
  }

  stop() {
    this.#run++
    this.#started = false
    this.#ui?.[Symbol.dispose]?.()
    this.#ui = undefined
  }

  /** Reads it all again, as on a new connection, with what is shown left up meanwhile. */
  restart() {
    const wanted = this.#started
    this.stop()
    if (wanted || this.#wanted > 0) this.start()
  }

  /** Reads the list again, such as after something was changed. */
  refresh = () => this.#load(this.#run)

  /** Adds Skills for a user who has none, where the deployment offers them. */
  turnOn = async () => {
    await this.api().provisionAmbientAccount(SKILLS_APP)
    this.restart()
  }

  /** One skill, whole, or null when there is no such skill the viewer can read. */
  read = async (id: string): Promise<SkillContent | null> => {
    const where = parseSkillId(id)
    if (!where) return null
    const ui = await this.#ready()
    const document = await ui.getContextDocument(where.collectionId, where.path)
    const manifest = document && readSkillManifest(document.body)
    if (!document || document.skillName === undefined || !manifest) return null
    return {
      id,
      ...where,
      name: document.skillName,
      description: manifest.description,
      lastUpdated: new Date(document.lastUpdated),
      instructions: manifest.instructions,
      body: document.body,
    }
  }

  /**
   * Makes a skill called `title` (in plain words; its name is made from them), in `collectionId`,
   * or in the viewer's own collection, made for it if they have none. Resolves to its id.
   */
  create = async ({ collectionId, title, description, instructions }: { collectionId?: string; title: string; description: string; instructions: string }) => {
    const name = skillNameFor(title)
    if (!isSkillName(name)) throw new Error('Give it a name made of letters or numbers.')
    validateDescription(description)
    const ui = await this.#ready()
    const into = collectionId ?? await this.#ownCollection(ui)
    const path = `${name}/SKILL.md`
    await ui.createContextSkill(into, path, { description: description.trim(), body: newSkillManifest({ name, description: description.trim(), instructions }) })
    await this.refresh()
    return `${into}/${path}`
  }

  /** Changes when a skill is used and what it says, keeping whatever else its manifest holds. */
  save = async (skill: SkillContent, { description, instructions }: { description: string; instructions: string }) => {
    validateDescription(description)
    const ui = await this.#ready()
    await ui.putContextDocument(skill.collectionId, skill.path, {
      description: description.trim(),
      body: updateSkillManifest(skill.body, { description: description.trim(), instructions }),
    })
    await this.refresh()
  }

  /** Renames a skill, which moves it with its name. Resolves to its new id. */
  rename = async (skill: Skill, title: string) => {
    const name = skillNameFor(title)
    if (!isSkillName(name)) throw new Error('Give it a name made of letters or numbers.')
    if (name === skill.name) return skill.id
    const ui = await this.#ready()
    await ui.renameContextSkill(skill.collectionId, skill.path, name)
    await this.refresh()
    // The directory takes the new name; the manifest stays its file within.
    const directory = skill.path.slice(0, skill.path.lastIndexOf('/'))
    const parent = directory.includes('/') ? directory.slice(0, directory.lastIndexOf('/') + 1) : ''
    return `${skill.collectionId}/${parent}${name}/SKILL.md`
  }

  /** Deletes a skill, with the files beside it. */
  remove = async (skill: Skill) => {
    const ui = await this.#ready()
    await ui.deleteContextSkill(skill.collectionId, skill.path)
    await this.refresh()
  }

  /** A new collection of the viewer's own, or with `forEveryone`, the deployment's (admins only). */
  createCollection = async (title: string, forEveryone = false) => {
    if (!title.trim()) throw new Error('Give it a name.')
    const ui = await this.#ready()
    const made = await ui.createContextCollection(title.trim(), '', forEveryone ? 'public' : 'private')
    await this.refresh()
    return made.id
  }

  renameCollection = async (collectionId: string, title: string) => {
    if (!title.trim()) throw new Error('Give it a name.')
    const ui = await this.#ready()
    await ui.updateContextCollection(collectionId, { title: title.trim() })
    await this.refresh()
  }

  /** Deletes a collection and every skill in it, for everyone it is shared with. */
  deleteCollection = async (collectionId: string) => {
    const ui = await this.#ready()
    await ui.deleteContextCollection(collectionId)
    await this.refresh()
  }

  /** Gives up the viewer's place in a collection someone shared with them. */
  leaveCollection = async (collectionId: string) => {
    const ui = await this.#ready()
    await ui.leaveContextCollection(collectionId)
    await this.refresh()
  }

  /** Who a collection is shared with. */
  sharing = async (collectionId: string) => (await this.#ready()).getContextCollectionSharing(collectionId)

  /** Shares a collection with someone found in the deployment's directory. */
  share = async (collectionId: string, userId: string, role: ContextCollectionRole) => {
    const selection = await this.api().createGatekeeperUserSelection(SKILLS_APP, userId)
    if (!selection) throw new Error('They can’t be found.')
    const ui = await this.#ready()
    await ui.shareContextCollection(collectionId, selection.ticket, role)
    await this.refresh()
  }

  setMemberRole = async (collectionId: string, memberId: string, role: ContextCollectionRole) =>
    (await this.#ready()).setContextCollectionMemberRole(collectionId, memberId, role)

  removeMember = async (collectionId: string, memberId: string) => {
    await (await this.#ready()).removeContextCollectionMember(collectionId, memberId)
    await this.refresh()
  }

  setEveryoneCanView = async (collectionId: string, everyone: boolean) => {
    await (await this.#ready()).setContextCollectionEveryoneCanView(collectionId, everyone)
    await this.refresh()
  }

  async #ready() {
    if (this.#ui) return this.#ui
    const ui = await this.#open()
    if (!ui) throw new Error('Skills aren’t turned on for you.')
    this.#ui = ui
    return ui
  }

  // The frame's `ui` is typed by each gatekeeper, not by the Workshop's API: the Skills
  // gatekeeper's is `ContextApi`, which it exports as its app API for exactly this.
  async #open() {
    const frame = await this.api().getGatekeeperApp(SKILLS_APP)
    return frame ? (frame.ui as unknown as SkillsUi) : undefined
  }

  // The viewer's first collection of their own, or one made for them.
  async #ownCollection(ui: SkillsUi) {
    const current = this.#snapshot
    const own = current.status === 'ready' ? current.collections.find(({ kind }) => kind === 'mine') : undefined
    if (own) return own.id
    return (await ui.createContextCollection(MY_SKILLS, 'Skills I wrote for the agent.', 'private')).id
  }

  async #load(run: number) {
    try {
      const ui = this.#ui ?? await this.#open()
      if (run !== this.#run) return
      if (!ui) {
        const addable = await this.api().listAddableGatekeepers()
        if (run === this.#run) this.#publish({ status: 'off', canTurnOn: addable.some(({ id }) => id === SKILLS_APP) })
        return
      }
      this.#ui = ui
      const [infos, viewer] = await Promise.all([ui.listEnabledContextCollections(), ui.getViewerInfo()])
      const collections = await Promise.all(infos.map(async (info): Promise<SkillCollection> => {
        const [documents, permissions] = await Promise.all([ui.listContextDocuments(info.id), ui.getContextCollectionPermissions(info.id)])
        return {
          id: info.id,
          title: info.title,
          icon: info.icon,
          kind: kindOf(info),
          shared: info.source === 'public' || (info.membership?.shared ?? false),
          role: info.membership?.role,
          permissions,
          skills: documents.flatMap((document) => skillOf(info.id, document) ?? []),
        }
      }))
      if (run !== this.#run) return
      this.#publish({ status: 'ready', collections: collections.toSorted(byPlace), isAdmin: viewer.isAdmin })
    } catch (error) {
      // What was read stays up when reading it again fails.
      if (run === this.#run && this.#snapshot.status !== 'ready') this.#publish({ status: 'failed', message: messageOf(error) })
    }
  }

  #publish(snapshot: SkillsSnapshot) {
    this.#snapshot = snapshot
    for (const listener of this.#listeners) listener()
  }
}

const validateDescription = (description: string) => {
  if (!description.trim()) throw new Error('Say when the agent should use it.')
  if (description.trim().length > MAX_SKILL_DESCRIPTION) throw new Error(`Say when to use it in ${MAX_SKILL_DESCRIPTION} characters or fewer.`)
}
