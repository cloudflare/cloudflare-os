import type { BlueprintOutput, BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { APP } from './libraryList'

/**
 * Something to start from that somebody published: what the backend calls a blueprint, as the
 * library says it, with what the backend does not say of one yet: how many times it has been
 * used, and whether it is the organization's own rather than one of its people's.
 */
export type Template = BlueprintPublicInfo & { uses: number; organization?: true }

/** A service a template has to be connected to before it can be used. */
export type TemplateNeed = {
  /** Which of the template's it is. */
  key: string
  /** What its publisher called it: "Jira". */
  name: string
  /** What the template does with it, where its publisher said. */
  description: string
}

/** Who a template is by, as it is said where one is listed: its publisher, or the organization. */
export const templateCreator = ({ metadata, organization }: Template): { name: string; organization: boolean } =>
  organization ? { name: 'Your organization', organization: true } : { name: metadata.author.name, organization: false }

/** What making one from a template gives: what its publisher says, or an app. */
export const templateType = ({ metadata }: Template): BlueprintOutput => metadata.output ?? APP

/**
 * The services a template has to be connected to before it can be used: not the models it runs
 * on, nor what only an agent it starts is given.
 */
export const templateNeeds = ({ metadata }: Template): TemplateNeed[] =>
  Object.entries(metadata.bindings)
    .filter(([, binding]) => binding.type === 'gatekeeper' && !binding.spawnerOnly)
    .map(([key, { title, description }]) => ({ key, name: title, description }))

/** The types the templates make, each once, in the order they are first met. */
export const templateTypes = (templates: Template[]): BlueprintOutput[] => {
  const types = new Map<string, BlueprintOutput>()
  for (const type of templates.map(templateType)) {
    if (!types.has(type.id)) types.set(type.id, type)
  }
  return [...types.values()]
}

/** What a search looks through for a template: its title, what it is for, what it makes, who published it and what it needs. */
export const templateSearchText = (template: Template) => {
  const { noun, plural } = templateType(template)
  const { title, description, author } = template.metadata
  return [title, description, noun, plural, author.name, ...templateNeeds(template).map(({ name }) => name)].join(' ')
}
