import { groupByName, groupByTime, type ListFilter, type ListOrder, type ListViewSpec } from '@gadgets/ui'
import type { SkillOwner } from './SkillRow'
import type { Skill } from './SkillStore'

/** Whose a skill is, where it is not the user's own. */
export const sourceLabel = ({ source }: Skill) => (source.kind === 'shared' ? `Shared by ${source.by}` : source.kind === 'organization' ? 'Organization' : undefined)

/** Who the user is where their own skills are listed: the app is not told their name. */
export const YOU = 'You'

/** Whose a skill is, as its row shows it: the user, called `userName`, whoever shared it with them, or the organization. */
export const skillOwner = ({ source }: Pick<Skill, 'source'>, userName: string): SkillOwner =>
  source.kind === 'organization' ? { kind: 'organization' } : source.kind === 'shared' ? { kind: 'person', name: source.by } : { kind: 'person', name: userName, you: true }

/** The tags the skills have, each once, by name. */
export const skillTags = (skills: Skill[]) => [...new Set(skills.flatMap(({ tag }) => tag ?? []))].toSorted((a, b) => a.localeCompare(b))

const latestFirst = (skills: Skill[]) => skills.toSorted((a, b) => b.updated.getTime() - a.updated.getTime())

/**
 * Under their tags, by name, the latest updated first within each, and those with none last. A tag
 * is a group of its own however few it has: folded into its neighbour it would say nothing of either.
 */
const byTag: ListOrder<Skill> = {
  id: 'tag',
  label: 'Collection',
  arrange: (skills) =>
    [...skillTags(skills), undefined]
      .map((tag) => ({
        key: tag === undefined ? 'none' : `tag:${tag}`,
        label: tag ?? 'My skills',
        entries: latestFirst(skills.filter((skill) => skill.tag === tag)).map((value) => ({ value })),
      }))
      .filter(({ entries }) => entries.length > 0),
}

const SOURCE_FILTERS: ListFilter<Skill>[] = [
  { id: 'mine', label: 'Mine', facet: 'source', test: ({ source }) => source.kind === 'mine' },
  { id: 'shared', label: 'Shared with me', facet: 'source', test: ({ source }) => source.kind === 'shared' },
  { id: 'organization', label: 'Organization', facet: 'source', test: ({ source }) => source.kind === 'organization' },
]

/** A filter for each tag, once there is more than one to choose between. */
const tagFilters = (skills: Skill[]): ListFilter<Skill>[] => {
  const tags = skillTags(skills)
  return tags.length < 2 ? [] : tags.map((tag) => ({ id: `tag:${tag}`, label: tag, facet: 'tag', test: (skill) => skill.tag === tag }))
}

/**
 * How the skills can be ordered, narrowed and searched: by when they were last updated, by name,
 * by tag, by whose they are, and by what they are for. To start with it is the user's own and
 * those shared with them: the organization's are a filter away.
 */
export const skillList = (skills: Skill[]): ListViewSpec<Skill, ListOrder<Skill>> => ({
  orders: [
    {
      id: 'updated',
      label: 'Last updated',
      arrange: (all, enough) => groupByTime(latestFirst(all).map((skill) => ({ value: skill, at: skill.updated })), new Date(), enough),
    },
    { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, ({ name }) => name, enough) },
    byTag,
  ],
  filters: [...SOURCE_FILTERS, ...tagFilters(skills)],
  // The organization's are everyone's, and many: they are listed once asked for.
  startsNarrowedTo: ['mine', 'shared'],
  // What is left out is the user's to say from then on, so it is as they left it when they come back.
  keepsFilters: true,
  // As many as the user has made, so they have a menu of their own.
  facetMenus: { tag: 'Collection' },
  searchText: (skill) => [skill.name, skill.description, skill.tag, sourceLabel(skill)].filter(Boolean).join(' '),
})
