import type { OutputFormatOffer } from '@gadgets/workshop-shared/api'
import type { ComposerAddOffer } from '@/blocks/composerAddEntries'
import { AGENT_DRAFT, AUTOMATION_DRAFT } from '@/automations/startDrafts'
import { AgentIcon } from '@/components/AgentIcon'
import { FormatIcon } from '@/components/FormatIcon'
import { FlashIcon } from '@/components/icons'
import { ServiceLogo } from '@/components/ServiceLogo'
import { AGENT_KEY, type AddableService } from '@/connections/connectionChoices'
import { recentlyAdded } from '@/library/templateList'
import { templateSearchText, templateType, type Template } from '@/library/templates'
import type { StartFormat } from './startWithFormat'

// How many of each kind the menu opens with, before anything is typed.
const SUGGESTED_FORMATS = 3
const SUGGESTED_CONNECTIONS = 4

// What choosing a format does, in a few words: "Make a document", "Make an app", "Make slides"
// for one named in the plural.
const makes = ({ noun, plural }: { noun: string; plural: string }) => {
  const named = noun.toLowerCase()
  if (noun === plural) return `Make ${named}`
  return `Make ${/^[aeiou]/.test(named) ? 'an' : 'a'} ${named}`
}

// A format is asked for by its name, which one that has something to set up first cannot be.
// Nothing else is called what it is, so its row ends in what choosing it does.
const formatOffers = (formats: readonly OutputFormatOffer[], onStartWith: (start: StartFormat) => void) =>
  formats.filter(({ requiresSetup }) => !requiresSetup).map(({ output: { id, noun, plural, icon }, description }, index): ComposerAddOffer => ({
    key: `format:${id}`,
    group: 'format',
    title: noun,
    detail: makes({ noun, plural }),
    keywords: [plural, description, 'create', 'make', 'start'],
    icon: <FormatIcon name={icon} />,
    suggested: index < SUGGESTED_FORMATS,
    onChoose: () => onStartWith({ noun, icon, description: description.trim() || undefined }),
  }))

// Whose a template is, which tells it from a format or a skill of its name.
const templateDetail = ({ organization, mine, metadata }: Template) =>
  organization ? 'Template' : mine ? 'Your template' : metadata.author.name ? `Template · ${metadata.author.name}` : 'Template'

/**
 * The organization's own first, then the starred, then the rest, the latest created first within
 * each. One with no title is left out, as it is asked for by its title; so is one a format stands
 * for, which is offered as that format.
 */
const templateOffers = (templates: readonly Template[], stars: readonly string[], formats: readonly OutputFormatOffer[], onStartWith: (start: StartFormat) => void) => {
  const asFormat = new Set(formats.filter(({ requiresSetup }) => !requiresSetup).map(({ blueprintId }) => blueprintId))
  const starred = new Set(stars)
  const rank = (template: Template) => (template.organization ? 0 : starred.has(template.id) ? 1 : 2)
  return recentlyAdded(templates.filter(({ id, metadata }) => metadata.title.trim() !== '' && !asFormat.has(id)))
    .toSorted((a, b) => rank(a) - rank(b))
    .map((template): ComposerAddOffer => {
      const noun = template.metadata.title.trim()
      const { icon } = templateType(template)
      return {
        key: `template:${template.id}`,
        group: 'template',
        title: noun,
        detail: templateDetail(template),
        keywords: [templateSearchText(template), 'template', 'blueprint'],
        icon: <FormatIcon name={icon} />,
        onChoose: () => onStartWith({ noun, icon, template: true, description: template.metadata.description.trim() || undefined }),
      }
    })
}

// What a service's row ends in: that it is still to be signed in to, or else what of it can be
// connected, which is chosen next, unless that is only its own name again.
const serviceDetail = ({ service, connected, kinds, about }: AddableService) => {
  if (about) return about
  if (!connected) return 'Sign in to connect'
  const offered = kinds.map(({ title }) => title).join(', ')
  return offered.toLowerCase() === service.name.toLowerCase() ? 'Add a connection' : offered
}

// A service once, whatever it has to connect: which of its kinds is chosen after it. The first
// few services open the menu, the user's own first: not a model or an agent, which are no service.
const connectionOffers = (services: readonly AddableService[], onConnect: (service: AddableService) => void) => {
  const first = new Set(services.filter(({ about }) => !about).slice(0, SUGGESTED_CONNECTIONS))
  return services.map((service): ComposerAddOffer => ({
    key: `connection:${service.key}`,
    group: 'connection',
    title: service.service.name,
    detail: serviceDetail(service),
    keywords: [...service.kinds.flatMap(({ title, description }) => [title, description ?? '']), 'connect', 'connection', 'add'],
    // An agent in the menu's own line, as its other glyphs are, rather than as the solid cloud.
    icon: service.key === AGENT_KEY ? <AgentIcon /> : service.service.glyph ?? <ServiceLogo bare name={service.service.name} src={service.service.logoUrl} />,
    suggested: first.has(service),
    opens: true,
    onChoose: () => onConnect(service),
  }))
}

// The agent sets these up from what it is asked, so choosing one writes the start of the request.
const setupOffers = (onDraft: (text: string) => void): ComposerAddOffer[] => [
  {
    key: 'setup:automation',
    group: 'setup',
    title: 'Automation',
    detail: 'Runs on a schedule or trigger',
    keywords: ['automate', 'scheduled', 'task', 'recurring', 'every', 'daily', 'weekly', 'when', 'hook'],
    icon: <FlashIcon aria-hidden="true" />,
    suggested: true,
    onChoose: () => onDraft(AUTOMATION_DRAFT),
  },
  {
    key: 'setup:agent',
    group: 'setup',
    title: 'Agent',
    detail: 'Handles a task on its own',
    keywords: ['assistant', 'bot', 'worker', 'autonomous'],
    icon: <AgentIcon />,
    suggested: true,
    onChoose: () => onDraft(AGENT_DRAFT),
  },
]

/**
 * What a chat's + menu offers besides uploading and the skills, each kind in the order it is
 * offered in, with those the menu opens with marked: the formats the deployment offers, in its
 * order, the first few; setting up an automation or an agent, where one can be (`onDraft`, which
 * writes the start of the request for the user to finish); the services something can be
 * connected of, as `services` has them, the likeliest first, a handful of them, where a
 * connection can be added (`onConnect`, which goes on to which of the service's kinds); and the
 * templates, the organization's own first, which are found by typing. A format or a template is
 * what the next message starts with (`onStartWith`).
 */
export const composerOffers = ({ formats, templates, stars, services, onStartWith, onConnect, onDraft }: {
  formats: readonly OutputFormatOffer[]
  templates: readonly Template[]
  /** The ids of the starred templates. */
  stars: readonly string[]
  services: readonly AddableService[]
  onStartWith: (start: StartFormat) => void
  onConnect?: (service: AddableService) => void
  onDraft?: (text: string) => void
}): ComposerAddOffer[] => [
  ...formatOffers(formats, onStartWith),
  ...(onDraft ? setupOffers(onDraft) : []),
  ...(onConnect ? connectionOffers(services, onConnect) : []),
  ...templateOffers(templates, stars, formats, onStartWith),
]
