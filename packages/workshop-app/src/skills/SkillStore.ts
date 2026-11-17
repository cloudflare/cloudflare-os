import { stringify } from 'yaml'
import { MANIFEST, type SkillFile } from './skillFiles'
import { humanizeSkillName, isValidSkillName, skillNameFromTitle } from './skillName'
import { readSkillUploadSource, writeSkillUploadMetadata, type SkillUploadCandidate } from './skillUpload'

/**
 * A skill: instructions the assistant loads when a task calls for them, with whatever files they
 * refer to. They are one flat list: what used to be the collection a skill was in is a tag on it.
 */
export type Skill = {
  id: string
  /** What it is called, as it is read: "Summarize meeting notes". */
  name: string
  /** What it is for, which is what the assistant goes by to load it. */
  description: string
  /** What it is filed under, if anything. */
  tag?: string
  /** Whose it is: the user's own, somebody's who shared it with them, or the deployment's, for everyone. */
  source: { kind: 'mine' } | { kind: 'shared'; by: string } | { kind: 'organization' }
  updated: Date
  /** The assistant may load it on its own, when a request matches what it is for. */
  autoUse: boolean
  /** Its files: `SKILL.md` first, which has its name and what it is for over its instructions, then the rest by path. */
  files: SkillFile[]
}

/** A skill as it is written from nothing: what it is called, what it is for, and a tag, if any. */
export type WrittenSkill = { name: string; description: string; tag?: string }

const MARKDOWN = 'text/markdown'

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

/** What `SKILL.md` says the skill is called and is for, each where it says so in words. */
const metadataOf = (body: string) => {
  const { document } = readSkillUploadSource(body)
  const name = document?.get('name')
  const description = document?.get('description')
  return { name: typeof name === 'string' ? name : undefined, description: typeof description === 'string' ? description.trim() : undefined }
}

/**
 * What a skill is called, from the name `SKILL.md` gives it, which is in lowercase with hyphens:
 * the title it has, while that is still what the name was made from, and otherwise the name with
 * its words capitalized.
 */
const titleFor = (metadataName: string, title: string | undefined) =>
  title !== undefined && skillNameFromTitle(title) === metadataName ? title : humanizeSkillName(metadataName)

const inOrder = (files: SkillFile[]) =>
  files.toSorted((a, b) => Number(b.path === MANIFEST) - Number(a.path === MANIFEST) || a.path.localeCompare(b.path))

/**
 * The user's skills and their files, and what can be done to them. A skill's name and what it is
 * for are kept twice, on the skill and in its `SKILL.md`, which is what the assistant reads: a
 * change to either is made to the other.
 *
 * It keeps them in memory, for as long as the page is up: the Workshop's API has no skills of the
 * user's to read or write yet (they are the Context Library's, which has its own app). Its shape
 * is that of the operations a backend would have, to be put over one once it does.
 */
export class SkillStore {
  #skills: Skill[]
  readonly #listeners = new Set<() => void>()
  #made = 0

  constructor(
    initial: Skill[] = [],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#skills = initial
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** The skills, in the order they were added. The same array until one of them changes. */
  getSnapshot = () => this.#skills

  get(id: string) {
    return this.#skills.find((skill) => skill.id === id)
  }

  #set(skills: Skill[]) {
    this.#skills = skills
    for (const listener of this.#listeners) listener()
  }

  /** Changes a skill, which is then updated as of now, unless what changed is how it is used rather than what it is (`quietly`). */
  #change(id: string, change: (skill: Skill) => Skill, quietly = false) {
    this.#set(this.#skills.map((skill) => (skill.id === id ? { ...change(skill), ...(quietly ? {} : { updated: this.now() }) } : skill)))
  }

  #create(skill: Omit<Skill, 'id' | 'source' | 'updated' | 'autoUse'>): Skill {
    return { ...skill, id: `skill-${(this.#made += 1)}`, source: { kind: 'mine' }, updated: this.now(), autoUse: true, files: inOrder(skill.files) }
  }

  /** Whether a skill can be called `title`: a name in letters and numbers can be made of it. */
  static canBeCalled(title: string) {
    return isValidSkillName(skillNameFromTitle(title))
  }

  /** Adds a skill written from nothing, with a `SKILL.md` that says what it is. Gives its id. */
  add({ name, description, tag }: WrittenSkill): string {
    const skill = this.#create({
      name,
      description,
      tag,
      files: [{ path: MANIFEST, contentType: MARKDOWN, body: manifestOf(skillNameFromTitle(name), description, `# ${name}\n\n`) }],
    })
    this.#set([...this.#skills, skill])
    return skill.id
  }

  /**
   * Adds the skills made out of files that were chosen (`prepareSkillUploads`), each with its
   * `SKILL.md` and the files that came with it. One whose file says nothing of its name or what it
   * is for, or nothing that can be gone by, is given both from what it was called. Gives their ids.
   */
  addUploads(candidates: SkillUploadCandidate[]): string[] {
    const added = candidates.map((candidate) => {
      const fromLabel = skillNameFromTitle(candidate.label)
      const name = isValidSkillName(candidate.name) ? candidate.name : isValidSkillName(fromLabel) ? fromLabel : 'untitled-skill'
      const title = humanizeSkillName(name)
      const description = candidate.description.trim() || `Instructions for ${title}.`
      return this.#create({
        name: title,
        description,
        files: [{ path: MANIFEST, contentType: MARKDOWN, body: writeSkillUploadMetadata(candidate.manifestBody, name, description) }, ...candidate.supportingFiles],
      })
    })
    this.#set([...this.#skills, ...added])
    return added.map(({ id }) => id)
  }

  /** Calls a skill something else, in its `SKILL.md` too. Not done, and false, where no name can be made of `title`. */
  rename(id: string, title: string): boolean {
    if (!SkillStore.canBeCalled(title)) return false
    this.#change(id, (skill) => ({ ...skill, name: title, files: this.#withManifest(skill, skillNameFromTitle(title), skill.description) }))
    return true
  }

  /** Says something else of what a skill is for, in its `SKILL.md` too. */
  describe(id: string, description: string) {
    this.#change(id, (skill) => ({ ...skill, description, files: this.#withManifest(skill, skillNameFromTitle(skill.name), description) }))
  }

  #withManifest(skill: Skill, name: string, description: string): SkillFile[] {
    const manifest = skill.files.find(({ path }) => path === MANIFEST)
    const body = manifest ? withMetadata(manifest.body, name, description) : manifestOf(name, description)
    return inOrder([{ path: MANIFEST, contentType: MARKDOWN, body }, ...skill.files.filter(({ path }) => path !== MANIFEST)])
  }

  /** Files a skill under `tag`, or under nothing. */
  setTag(id: string, tag: string | undefined) {
    this.#change(id, (skill) => ({ ...skill, tag: tag?.trim() || undefined }))
  }

  setAutoUse(id: string, autoUse: boolean) {
    this.#change(id, (skill) => ({ ...skill, autoUse }), true)
  }

  /**
   * Puts files in a skill, each in place of the one at its path, if there is one. A `SKILL.md`
   * among them is the skill's own from then on, so the skill is called and is for what it says.
   */
  putFiles(id: string, files: SkillFile[]) {
    const paths = new Set(files.map(({ path }) => path))
    this.#change(id, (skill) => this.#read({ ...skill, files: inOrder([...skill.files.filter(({ path }) => !paths.has(path)), ...files]) }))
  }

  /** Keeps what was written in one of a skill's files. Written in `SKILL.md`, the skill is called and is for what it says. */
  saveFile(id: string, path: string, body: string) {
    this.#change(id, (skill) => this.#read({ ...skill, files: skill.files.map((file) => (file.path === path ? { ...file, body } : file)) }))
  }

  /** The skill, called and for what its `SKILL.md` says, where it says so in a way that can be gone by. */
  #read(skill: Skill): Skill {
    const manifest = skill.files.find(({ path }) => path === MANIFEST)
    if (!manifest) return skill
    const { name, description } = metadataOf(manifest.body)
    return {
      ...skill,
      name: name !== undefined && isValidSkillName(name) ? titleFor(name, skill.name) : skill.name,
      description: description || skill.description,
    }
  }

  /** Takes a file out of a skill. Not its `SKILL.md`, without which it is not one. */
  removeFile(id: string, path: string) {
    if (path === MANIFEST) return
    this.#change(id, (skill) => ({ ...skill, files: skill.files.filter((file) => file.path !== path) }))
  }

  remove(id: string) {
    this.#set(this.#skills.filter((skill) => skill.id !== id))
  }
}
