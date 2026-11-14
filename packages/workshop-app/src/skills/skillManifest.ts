import { isMap, parseDocument, stringify } from 'yaml'

/**
 * A skill's manifest (`SKILL.md`), as a person thinks of it: when the agent should use it and what
 * it says. Everything else its frontmatter holds is kept as it was, as other tools write it too.
 */
export type SkillManifest = {
  /** Its name, as the agent and slash commands know it: `meeting-brief`. */
  name: string
  /** What it does and when to use it, which the agent reads to decide. */
  description: string
  /** What follows the frontmatter: the instructions themselves, in Markdown. */
  instructions: string
}

// What a manifest's name may be (gatekeeper-context's `agent-skill.ts`), and how long.
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_DESCRIPTION = 1024

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Whether a name is one a skill can have. */
export const isSkillName = (name: string) => name.length <= MAX_SKILL_NAME && NAME.test(name)

/**
 * A skill's name in plain words: `meeting-brief` is "Meeting brief". Only the first letter is made
 * a capital, so a name that means something in lowercase still reads as a phrase.
 */
export const skillTitle = (name: string) => {
  const words = name.replace(/-+/g, ' ').trim()
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : name
}

/**
 * The name a skill called `title` gets: "Meeting brief" is `meeting-brief`. Letters lose their
 * accents and anything else becomes a single hyphen, so whatever is typed makes a valid name, or
 * nothing when nothing of it can.
 */
export const skillNameFor = (title: string) =>
  title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_SKILL_NAME)
    .replace(/-$/, '')

/** A manifest's parts, or nothing for one whose frontmatter is not a map with a name. */
export const readSkillManifest = (body: string): SkillManifest | undefined => {
  const match = FRONTMATTER.exec(body)
  if (!match) return undefined
  const document = parseDocument(match[1])
  if (document.errors.length > 0 || !isMap(document.contents)) return undefined
  const name = document.get('name')
  const description = document.get('description')
  if (typeof name !== 'string') return undefined
  return {
    name,
    description: typeof description === 'string' ? description : '',
    instructions: body.slice(match[0].length).replace(/^\r?\n/, ''),
  }
}

/**
 * The manifest `body` with a new description and instructions, its frontmatter's other keys, and
 * their comments, kept as they were.
 */
export const updateSkillManifest = (body: string, { description, instructions }: Pick<SkillManifest, 'description' | 'instructions'>) => {
  const match = FRONTMATTER.exec(body)
  if (!match) throw new Error('This skill’s file has no frontmatter to keep its name in.')
  const document = parseDocument(match[1])
  if (document.errors.length > 0) throw new Error('This skill’s frontmatter can’t be read, so it can’t be changed here.')
  document.set('description', description)
  return `---\n${document.toString().trimEnd()}\n---\n\n${instructions.trim()}\n`
}

/** A new skill's manifest. */
export const newSkillManifest = ({ name, description, instructions }: SkillManifest) =>
  `---\n${stringify({ name, description }).trimEnd()}\n---\n\n${instructions.trim()}\n`
