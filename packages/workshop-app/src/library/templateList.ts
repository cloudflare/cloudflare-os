import type { BlueprintOutput } from '@gadgets/workshop-shared/api'
import { type ListFilter, type ListOrder, type ListViewSpec, groupByName } from '@gadgets/ui'
import { templateNeeds, templateSearchText, templateType, templateTypes, type Template } from './templates'

/** The latest created first. */
export const recentlyAdded = (templates: Template[]): Template[] =>
  templates.toSorted((a, b) => b.metadata.created.getTime() - a.metadata.created.getTime())

/**
 * The templates under what they make, the latest created first within each: the kinds in the order
 * of the latest created of each, so that what is newest leads.
 */
export const templatesByType = (templates: Template[]): Array<{ type: BlueprintOutput; templates: Template[] }> => {
  const ranked = recentlyAdded(templates)
  return templateTypes(ranked).map((type) => ({ type, templates: ranked.filter((template) => templateType(template).id === type.id) }))
}

/** All of them as one group, in the order `sort` puts them. */
const inOne = (id: string, label: string, sort: (templates: Template[]) => Template[]): ListOrder<Template> => ({
  id,
  label,
  arrange: (templates) => (templates.length === 0 ? [] : [{ key: id, label, entries: sort(templates).map((value) => ({ value })) }]),
})

/** A filter for each service some template needs, by name. */
const needFilters = (templates: Template[]): ListFilter<Template>[] =>
  [...new Set(templates.flatMap((template) => templateNeeds(template).map(({ name }) => name)))]
    .toSorted((a, b) => a.localeCompare(b))
    .map((name) => ({
      id: `needs:${name}`,
      label: name,
      facet: 'needs',
      test: (template) => templateNeeds(template).some((need) => need.name === name),
    }))

/**
 * How the templates can be ordered, narrowed and searched: by when they were created and by title;
 * by whether they are starred (`starred`, the ids of those that are), by whether they need anything
 * connected, and by the services they work with, a menu of its own. What they make is not a filter:
 * the page has a tab for each kind.
 */
export const templateList = (templates: Template[], starred: ReadonlySet<string>): ListViewSpec<Template, ListOrder<Template>> => ({
  orders: [
    inOne('recent', 'Recently added', recentlyAdded),
    { id: 'name', label: 'Name', arrange: (all, enough) => groupByName(all, ({ metadata }) => metadata.title, enough) },
  ],
  filters: [
    { id: 'starred', label: 'Starred', test: ({ id }) => starred.has(id) },
    { id: 'ready', label: 'No connections needed', test: (template) => templateNeeds(template).length === 0 },
    ...needFilters(templates),
  ],
  // As many as the templates there are need, and they come and go with them.
  facetMenus: { needs: 'Works with' },
  searchText: templateSearchText,
  startsAs: 'cards',
})
