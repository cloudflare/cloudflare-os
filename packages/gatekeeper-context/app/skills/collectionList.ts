import type { ContextCollectionRole } from '../../src/context-types'
import { groupByName, groupByTime, type ListOrder, type ListViewSpec } from '@gadgets/ui'
import type { Skill, SkillCollection } from './SkillStore'

/** What each role lets someone do with a collection, as its sharing says it. */
export const ROLE_LABELS: Record<ContextCollectionRole, string> = { viewer: 'Can use', editor: 'Can edit', owner: 'Owner' }

/** How many skills, in words: "No skills", "1 skill", "4 skills". */
export const skillCount = (count: number) => (count === 0 ? 'No skills' : count === 1 ? '1 skill' : `${count} skills`)

/** Who has a collection, where it is not only the user: "Shared", "Shared by Grace Hopper", "Organization". */
export const collectionAccess = ({ source, shared }: SkillCollection) =>
  source.kind === 'organization' ? 'Organization' : source.kind === 'shared' ? `Shared by ${source.by}` : shared ? 'Shared' : undefined

/** A collection's line where it is listed: how many skills, and who has it. */
export const collectionDetail = (collection: SkillCollection) => {
  const access = collectionAccess(collection)
  const count = skillCount(collection.skillCount)
  return access ? `${count} · ${access}` : count
}

/**
 * Whether the user can give up their place in a collection: one shared with them, which is
 * somebody else's. The last owner cannot leave, and an owner who is not the last leaves from who
 * has it, which knows whether another owner remains.
 */
export const canLeave = ({ source, role }: SkillCollection) => source.kind === 'shared' && role !== 'owner'

const latestFirst = (skills: Skill[]) => skills.toSorted((a, b) => b.updated.getTime() - a.updated.getTime())

/**
 * How one collection's skills can be ordered and searched, on its page: by when they were last
 * updated or by name. They are all the one collection's and the same person's, so nothing narrows them.
 */
export const collectionSkillList: ListViewSpec<Skill, ListOrder<Skill>> = {
  orders: [
    {
      id: 'updated',
      label: 'Last updated',
      arrange: (all, enough) => groupByTime(latestFirst(all).map((skill) => ({ value: skill, at: skill.updated })), new Date(), enough),
    },
    { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, ({ name }) => name, enough) },
  ],
  filters: [],
  searchText: ({ name, description }) => `${name} ${description}`,
}
