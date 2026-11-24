import type { OutputFormatOffer } from '@gadgets/workshop-shared/api'
import type { ComposerAddOffer } from '@/blocks/composerAddEntries'
import { composerOffers } from '@/chat/composerOffers'
import type { StartFormat } from '@/chat/startWithFormat'
import { AGENT_CHOICE, MODEL_CHOICE, type AddableConnection, type AddableService } from '@/connections/connectionChoices'
import { exampleTemplates } from '@/library/exampleTemplates'

const FORMATS: OutputFormatOffer[] = [
  { blueprintId: 'format-document', output: { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }, description: 'A page of writing.', requiresSetup: false },
  { blueprintId: 'format-slides', output: { id: 'slides', noun: 'Slides', plural: 'Slides', icon: 'presentation' }, description: 'A deck to present.', requiresSetup: false },
  { blueprintId: 'format-spreadsheet', output: { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table' }, description: 'Rows and columns.', requiresSetup: false },
]

// Logos as services give them: one image each, whatever the theme. A dark one, a white one drawn
// for a tile of its service's colour, and one in colours of its own.
const logo = (svg: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${svg}</svg>`)}`
const LOGOS: Record<string, string> = {
  GitHub: logo('<circle cx="12" cy="12" r="11" fill="#24292e"/><circle cx="12" cy="12" r="5" fill="#24292e"/>'),
  Email: logo('<g fill="none" stroke="#1f1308" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></g>'),
  Jira: logo('<path fill="#fff" stroke="#fff" d="M4 4h16v16H4z"/>'),
  Google: logo('<path fill="#4285f4" d="M12 2h10v10H12z"/><path fill="#ea4335" d="M2 2h10v10H2z"/><path fill="#fbbc05" d="M2 12h10v10H2z"/><path fill="#34a853" d="M12 12h10v10H12z"/>'),
}

const serviceOf = (name: string, kinds: string[], connected: boolean): AddableService => {
  const service = { name, logoUrl: LOGOS[name] }
  return { key: name, service, connected, kinds: kinds.map((title): AddableConnection => ({ key: `${name} ${title}`, service, title, connected })) }
}

// As `addableServices` orders them: the user's services, a model and an agent, then the rest.
const SERVICES: AddableService[] = [
  serviceOf('Google', ['Drive', 'Calendar', 'Gmail'], true),
  serviceOf('GitHub', ['Repository'], true),
  serviceOf('Email', ['Mailbox'], true),
  { key: MODEL_CHOICE.key, service: MODEL_CHOICE.service, connected: true, kinds: [MODEL_CHOICE], about: 'For a gadget to use' },
  { key: AGENT_CHOICE.key, service: AGENT_CHOICE.service, connected: true, kinds: [AGENT_CHOICE], about: 'For a gadget to call on' },
  serviceOf('Jira', ['Project'], false),
  serviceOf('Slack', ['Channel', 'Direct messages'], false),
  serviceOf('Notion', ['Page', 'Database'], false),
  serviceOf('Salesforce', ['Report', 'Account'], false),
]

/**
 * What a chat's + menu offers, by the app's own rules, over made-up formats, services and
 * templates. Each says what was chosen, and is done as well where there is someone to do it
 * (`does`): the draft started with a format, or given a connection of the service.
 */
export const previewComposerOffers = (say: (chosen: string) => void, does?: {
  onStartWith?: (format: StartFormat) => void
  onConnect?: (service: AddableService) => void
  onDraft?: (text: string) => void
}): ComposerAddOffer[] => {
  const templates = exampleTemplates()
  return composerOffers({
    formats: FORMATS,
    templates,
    stars: templates.slice(2, 3).map(({ id }) => id),
    services: SERVICES,
    onStartWith: (format) => {
      say(`Preview: start with ${format.template ? `the ${format.noun} template` : format.noun}.`)
      does?.onStartWith?.(format)
    },
    onConnect: (service) => {
      say(`Preview: add a connection from ${service.service.name}${service.kinds.length > 1 ? `, choosing among ${service.kinds.map(({ title }) => title).join(', ')}` : ''}.`)
      does?.onConnect?.(service)
    },
    onDraft: (text) => {
      say(`Preview: “${text}” is written in the draft.`)
      does?.onDraft?.(text)
    },
  })
}
