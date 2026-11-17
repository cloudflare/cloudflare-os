import {
  blueprintScreenshotUrl,
  type BlueprintLibrarySummary,
  type BlueprintOutput,
  type BlueprintPublicInfo,
  type BlueprintUserSummary,
  type GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import { APP } from './libraryList'

/** A service a template's binding is to, as the deployment names it (`GatekeeperVendorInfo`). */
export type TemplateService = { name: string; logoUrl?: string; color?: string }

/**
 * Something to start from that somebody published: what the backend calls a blueprint, as the
 * library says it, with how many times it has been used, which the backend does not say yet;
 * whether it is the organization's own (one the deployment features) rather than one of its
 * people's; whether it is the user's own, published by them; and the services its bindings are
 * to, by the binding, where the deployment has them.
 */
export type Template = BlueprintPublicInfo & {
  uses?: number
  organization?: true
  mine?: true
  services?: Record<string, TemplateService>
}

/** A service a template has to be connected to before it can be used. */
export type TemplateNeed = {
  /** Which of the template's it is. */
  key: string
  /** The service: "Jira", or what its publisher called it where the deployment does not have it. */
  name: string
  /** What the template does with it, where its publisher said. */
  description: string
  logoUrl?: string
  /** The service's id, as the deployment's vendors have it (`GATEKEEPER_<NAME>`, lowercased). */
  vendorId: string
  /** The kind of resource it is given (`SupportedResource.urlPattern`). */
  urlPattern: string
  /** The one its publisher had, to start the service's form with. */
  resourceUrl?: string
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
export const templateNeeds = ({ metadata, services = {} }: Template): TemplateNeed[] =>
  Object.entries(metadata.bindings).flatMap(([key, binding]) => {
    if (binding.type !== 'gatekeeper' || binding.spawnerOnly) return []
    const service = services[key]
    return [{
      key,
      name: service?.name ?? binding.title,
      // Its publisher's name for what it is given says what it is for, once the service is named instead.
      description: service ? binding.description || binding.title : binding.description,
      logoUrl: service?.logoUrl,
      vendorId: binding.gatekeeperName.toLowerCase(),
      urlPattern: binding.typeUrlPattern,
      resourceUrl: binding.resourceUrl,
    }]
  })

/** The services a template needs, each once, however many of its bindings are to it, as where it is listed they are shown. */
export const templateServices = (template: Template): TemplateNeed[] => [...new Map(templateNeeds(template).map((need) => [need.name, need])).values()]

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

/** What the templates are read from: the deployment's featured blueprints, those the user saved or uploaded, and those they published, each of those with its public record where it could be read. */
export type TemplateSources = {
  featured: readonly BlueprintPublicInfo[]
  library: readonly BlueprintLibrarySummary[]
  own: readonly { summary: BlueprintUserSummary; info: BlueprintPublicInfo | null }[]
  /** The deployment's services, to name what a template's bindings are to. */
  vendors: readonly GatekeeperVendorInfo[]
}

/**
 * Every template the user can find, once each however many ways they have it: those the deployment
 * features, which are the organization's, then those they saved or uploaded, then those they
 * published, which are theirs. One published whose public record could not be read is left out,
 * as there is nothing to show of it. With the ids of the starred ones (the backend's `pinned`),
 * in the order they are listed.
 */
export const templatesOf = ({ featured, library, own, vendors }: TemplateSources): { templates: Template[]; stars: string[] } => {
  const byId = new Map<string, Template>()
  const stars = new Set<string>()
  const put = (info: BlueprintPublicInfo, extra: Partial<Template>) => byId.set(info.id, { ...(byId.get(info.id) ?? info), ...extra })
  for (const info of featured) put(info, { organization: true })
  for (const { id, metadata, pinned } of library) {
    if (!byId.has(id)) put({ id, metadata, screenshotUrl: blueprintScreenshotUrl(id, metadata) }, {})
    if (pinned) stars.add(id)
  }
  for (const { summary, info } of own) {
    if (summary.pinned) stars.add(summary.id)
    // One the user added rather than published is in their library, and listed from there.
    if (info && summary.source.type !== 'imported') put(info, { mine: true })
  }
  const named = new Map(vendors.map(({ id, description }) => [id, { name: description.displayName, logoUrl: description.logo?.url, color: description.color }]))
  const templates = [...byId.values()].map((template) => {
    const services = Object.fromEntries(Object.entries(template.metadata.bindings).flatMap(([key, binding]) => {
      const service = binding.type === 'gatekeeper' ? named.get(binding.gatekeeperName.toLowerCase()) : undefined
      return service ? [[key, service]] : []
    }))
    return Object.keys(services).length > 0 ? { ...template, services } : template
  })
  return { templates, stars: templates.flatMap(({ id }) => (stars.has(id) ? [id] : [])) }
}
