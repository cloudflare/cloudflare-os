import type { SkillCollection, Skill } from './SkillsLibrary'
import { skillTitle } from './skillManifest'

/** A collection as the Skills tab shows it: its skills that fit the search, in the order chosen. */
export type SkillGroup = { collection: SkillCollection; skills: Skill[] }

const fits = (skill: Skill, words: string[]) => {
  const text = `${skillTitle(skill.name)} ${skill.name} ${skill.description}`.toLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The collections to show, each with its skills: latest changed first, or by name. A search keeps
 * the skills whose name or description has every word typed, and the collections that still have
 * one. Without a search, the viewer's own collections stay even while empty, as the place a new
 * skill goes; anyone else's is left out until it has a skill.
 */
export const skillGroups = (collections: readonly SkillCollection[], { sort, query = '' }: { sort: 'recent' | 'name'; query?: string }): SkillGroup[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const order = sort === 'name'
    ? (a: Skill, b: Skill) => skillTitle(a.name).localeCompare(skillTitle(b.name))
    : (a: Skill, b: Skill) => b.lastUpdated.getTime() - a.lastUpdated.getTime()
  return collections.flatMap((collection) => {
    const skills = collection.skills.filter((skill) => fits(skill, words)).toSorted(order)
    const kept = skills.length > 0 || (words.length === 0 && collection.kind === 'mine')
    return kept ? [{ collection, skills }] : []
  })
}

/** Who has a collection, as its heading says after its name. */
export const collectionDetail = (collection: SkillCollection, organization?: string) => {
  if (collection.kind === 'everyone') return organization ? `For everyone at ${organization}` : 'For everyone'
  if (collection.kind === 'shared') return collection.role === 'viewer' ? 'Shared with you to use' : 'Shared with you'
  return collection.shared ? 'Shared' : undefined
}

/** Every skill, from all the collections, for the composer to offer. */
export const allSkills = (collections: readonly SkillCollection[]) =>
  collections.flatMap((collection) => collection.skills.map((skill) => ({ skill, collection })))
