import { describe, expect, it, vi } from 'vitest'
import type { OutputFormatOffer } from '@gadgets/workshop-shared/api'
import { MODEL_CHOICE, type AddableConnection, type AddableService } from '@/connections/connectionChoices'
import { exampleTemplates } from '@/library/exampleTemplates'
import { composerOffers } from './composerOffers'
import type { StartFormat } from './startWithFormat'

const format = (id: string, noun: string, requiresSetup = false): OutputFormatOffer =>
  ({ blueprintId: `format-${id}`, output: { id, noun, plural: `${noun}s`, icon: 'fileText' }, description: '', requiresSetup })

const service = (name: string, kinds: string[], connected = true): AddableService => ({
  key: name,
  service: { name },
  connected,
  kinds: kinds.map((title): AddableConnection => ({ key: `${name} ${title}`, service: { name }, title, connected })),
})

const NOTHING = { formats: [], templates: [], stars: [], services: [], onStartWith: () => {} }
const suggested = (offers: ReturnType<typeof composerOffers>) => offers.filter((offer) => offer.suggested).map(({ title }) => title)

describe('composerOffers', () => {
  it('offers the formats that are asked for by name, in the deployment’s order, the first few first', () => {
    const offers = composerOffers({ ...NOTHING, formats: [format('document', 'Document'), format('form', 'Form', true), format('report', 'Report'), format('sheet', 'Spreadsheet'), format('board', 'Board')] })
    expect(offers.map(({ title, detail }) => `${title} · ${detail}`)).toEqual(['Document · Make a document', 'Report · Make a report', 'Spreadsheet · Make a spreadsheet', 'Board · Make a board'])
    expect(suggested(offers)).toEqual(['Document', 'Report', 'Spreadsheet'])
  })

  it('starts the next message with the format chosen, and with a template as one', () => {
    const onStartWith = vi.fn<(start: StartFormat) => void>()
    const [template] = exampleTemplates()
    const offers = composerOffers({ ...NOTHING, formats: [format('slides', 'Slides'), { ...format('report', 'Report'), description: ' A written summary. ' }], templates: [template!], onStartWith })
    offers[0]!.onChoose()
    offers[1]!.onChoose()
    offers[2]!.onChoose()
    // With what each is for, where it says, which is said of it in the draft.
    expect(onStartWith.mock.calls).toEqual([
      [{ noun: 'Slides', icon: 'fileText' }],
      [{ noun: 'Report', icon: 'fileText', description: 'A written summary.' }],
      [{ noun: template!.metadata.title, icon: expect.any(String), template: true, description: template!.metadata.description }],
    ])
  })

  it('says what choosing a format does, one named in the plural and one that starts with a vowel included', () => {
    const offers = composerOffers({
      ...NOTHING,
      formats: [{ ...format('slides', 'Slides'), output: { id: 'slides', noun: 'Slides', plural: 'Slides', icon: 'presentation' } }, format('app', 'App')],
    })
    expect(offers.map(({ detail }) => detail)).toEqual(['Make slides', 'Make an app'])
  })

  it('offers a service once, whatever it has to connect, only where a connection can be added, opening with a handful that are services', () => {
    const model: AddableService = { key: MODEL_CHOICE.key, service: MODEL_CHOICE.service, connected: true, kinds: [MODEL_CHOICE], about: 'For a gadget to use' }
    const services = [service('Google', ['Drive', 'Calendar']), service('GitHub', ['Repository']), model, service('Jira', ['Project'], false), service('Slack', ['Channel'], false), service('Notion', ['Page'], false)]
    expect(composerOffers({ ...NOTHING, services })).toEqual([])
    const onConnect = vi.fn<(service: AddableService) => void>()
    const offers = composerOffers({ ...NOTHING, services, onConnect })
    expect(offers.map(({ title }) => title)).toEqual(['Google', 'GitHub', 'AI model', 'Jira', 'Slack', 'Notion'])
    expect(suggested(offers)).toEqual(['Google', 'GitHub', 'Jira', 'Slack'])
    offers[0]!.onChoose()
    expect(onConnect).toHaveBeenCalledWith(services[0])
  })

  it('says at a service’s end what of it can be connected, or that it is still to be signed in to, and finds it by its kinds', () => {
    const model: AddableService = { key: MODEL_CHOICE.key, service: MODEL_CHOICE.service, connected: true, kinds: [MODEL_CHOICE], about: 'For a gadget to use' }
    const offers = composerOffers({ ...NOTHING, services: [service('Google', ['Drive', 'Calendar']), service('Notion', ['Notion']), model, service('Slack', ['Channel'], false)], onConnect: () => {} })
    expect(offers.map(({ detail }) => detail)).toEqual(['Drive, Calendar', 'Add a connection', 'For a gadget to use', 'Sign in to connect'])
    expect(offers[0]!.keywords).toEqual(expect.arrayContaining(['Drive', 'Calendar']))
  })

  it('offers setting up an automation and an agent where one can be, each writing the start of the request', () => {
    expect(composerOffers(NOTHING).some(({ group }) => group === 'setup')).toBe(false)
    const onDraft = vi.fn<(text: string) => void>()
    const [automation, agent] = composerOffers({ ...NOTHING, onDraft })
    expect(automation).toMatchObject({ title: 'Automation', suggested: true })
    expect(agent).toMatchObject({ title: 'Agent', suggested: true })
    automation!.onChoose()
    agent!.onChoose()
    expect(onDraft.mock.calls).toEqual([['Set up an automation that '], ['Set up an agent that ']])
  })

  it('offers the templates, the organization’s first, then the starred, the latest created first, saying whose each is', () => {
    const templates = exampleTemplates()
    const own = templates.filter(({ organization }) => organization)
    const others = templates.filter(({ organization }) => !organization)
    const star = others.at(-1)!
    const offers = composerOffers({ ...NOTHING, templates, stars: [star.id] })
    expect(offers.slice(0, own.length).every(({ detail }) => detail === 'Template')).toBe(true)
    expect(offers[own.length]).toMatchObject({ key: `template:${star.id}`, detail: `Template · ${star.metadata.author.name}` })
    // Found by typing, rather than among what the menu opens with.
    expect(suggested(offers)).toEqual([])
  })

  it('leaves out a template that a format stands for, and one with no title to ask for it by', () => {
    const [first, second, third] = exampleTemplates()
    const offers = composerOffers({
      ...NOTHING,
      formats: [{ ...format('document', 'Document'), blueprintId: first!.id }],
      templates: [first!, { ...second!, metadata: { ...second!.metadata, title: ' ' } }, third!],
    })
    expect(offers.map(({ key }) => key)).toEqual(['format:document', `template:${third!.id}`])
  })
})
