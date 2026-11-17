import { groupByTime } from '@/chat/timeGroups'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import type { ListViewSpec } from '@/hooks/useListView'

/**
 * A skill: instructions the assistant loads when a task calls for them. They are one flat list:
 * what used to be the collection a skill was in is a tag on it.
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
}

/** Whose a skill is, where it is not the user's own. */
const sourceLabel = ({ source }: Skill) => (source.kind === 'shared' ? `Shared by ${source.by}` : source.kind === 'organization' ? 'Organization' : undefined)

/** What there is to say of a skill under its name, on one line: whose it is, where not the user's own, then what it is for. */
export const skillDetail = (skill: Skill) => [sourceLabel(skill), skill.description].filter(Boolean).join(' · ')

/** The tags the skills have, each once, by name. */
export const skillTags = (skills: Skill[]) => [...new Set(skills.flatMap(({ tag }) => tag ?? []))].toSorted((a, b) => a.localeCompare(b))

const latestFirst = (skills: Skill[]) => skills.toSorted((a, b) => b.updated.getTime() - a.updated.getTime())

/**
 * Under their tags, by name, the latest updated first within each, and those with none last. A tag
 * is a group of its own however few it has: folded into its neighbour it would say nothing of either.
 */
const byTag: ListOrder<Skill> = {
  id: 'tag',
  label: 'Tag',
  arrange: (skills) =>
    [...skillTags(skills), undefined]
      .map((tag) => ({
        key: tag === undefined ? 'none' : `tag:${tag}`,
        label: tag ?? 'No tag',
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
 * by tag, by whose they are, and by what they are for.
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
  // As many as the user has made, so they have a menu of their own.
  facetMenus: { tag: 'Tag' },
  searchText: (skill) => [skill.name, skill.description, skill.tag, sourceLabel(skill)].filter(Boolean).join(' '),
})
