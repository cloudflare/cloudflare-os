import { AiMagicIcon } from '@/components/icons'
import { AGENT_SPAWNER_CONNECTION_ID } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectionChoice } from '@/blocks/AddConnectionDialog'
import { AgentMark } from '@/blocks/AgentMark'
import { resourceGroups, type Connection } from './connectionList'
import { byServiceRelevance } from './serviceRelevance'

/** A kind of resource of a service that can be connected, with what its form is opened by. */
export type ServiceChoice = ConnectionChoice & {
  vendorId: string
  urlPattern: string
  /** The kinds its form may choose among, when it stands for more than one (`groupedWith`). */
  kinds: SupportedResource[]
}

/** One of the user's models, offered with the services, which has a page of its own. */
export const MODEL_KEY = 'ai-model'
/** How a model is drawn: a sparkle, as the Workshop's own cloud carries, rather than a brain. */
export const MODEL_SERVICE = { name: 'AI model', glyph: <AiMagicIcon aria-hidden="true" /> }
/** A model, as one of what can be connected. */
export const MODEL_CHOICE: ConnectionChoice = {
  key: MODEL_KEY,
  service: MODEL_SERVICE,
  title: 'AI model',
  description: 'One of your models, for a gadget’s code to use',
  connected: true,
}

/** An agent, offered with them too, as main's Workshop offered it: named and given a model on a page of its own. */
export const AGENT_KEY = AGENT_SPAWNER_CONNECTION_ID
/** How an agent is drawn, as it is everywhere else: the Workshop's cloud. */
export const AGENT_SERVICE = { name: 'Agent', glyph: <AgentMark size="small" /> }
/** An agent, as one of what can be connected. */
export const AGENT_CHOICE: ConnectionChoice = {
  key: AGENT_KEY,
  service: AGENT_SERVICE,
  title: 'Agent',
  description: 'Works on its own when a gadget calls on it',
  connected: true,
}

/** Something a chat can be given as a connection: a kind of a service's resource, a model or an agent. */
export type AddableConnection = ServiceChoice | ConnectionChoice

/**
 * Every kind of resource of the services that can be connected, by service and then by kind, each
 * saying whether the user has an account on its service.
 */
export const serviceChoices = (connections: readonly Connection[]): ServiceChoice[] => {
  const mine = new Set(connections.flatMap((each) => (each.kind === 'account' ? [each.vendorId] : [])))
  // A service once, whether it is listed for an account on it or to be connected.
  const services = new Map(connections.map((each) => [each.vendorId, each]))
  return [...services.values()]
    // Those the deployment provides come with every chat already.
    .filter(({ vendor }) => !vendor.autoProvisionsAccount)
    // A choice per group of kinds: Google Drive, rather than its folders, files and Docs apart.
    .flatMap(({ vendorId, vendor, resources }) => resourceGroups(resources).map(({ lead, members }): ServiceChoice => ({
      key: `${vendorId} ${lead.urlPattern}`,
      vendorId,
      urlPattern: lead.urlPattern,
      kinds: members,
      service: { name: vendor.displayName, logoUrl: vendor.logo?.url, color: vendor.color },
      title: lead.title,
      description: lead.description,
      connected: mine.has(vendorId),
    })))
    .toSorted((a, b) => a.service.name.localeCompare(b.service.name) || a.title.localeCompare(b.title))
}

/** A service something can be connected of, with every kind of it as one: what the + menu offers. */
export type AddableService = {
  key: string
  service: ConnectionChoice['service']
  /** The user has an account on it already. */
  connected: boolean
  /** Its kinds, in the order it offers them: which one is chosen next. */
  kinds: AddableConnection[]
  /** What it is for, in a few words, for what is not a service whose kinds say so. */
  about?: string
}

const alone = (choice: ConnectionChoice, about: string): AddableService => ({ key: choice.key, service: choice.service, connected: choice.connected, kinds: [choice], about })

/**
 * The services something can be connected of, the likeliest first: those the user has an account
 * on, the ones most people use first, then a model and an agent, which need none, then those
 * still to be signed in to, in the same order. Each once, with all of its kinds.
 */
export const addableServices = (connections: readonly Connection[]): AddableService[] => {
  // In the order each service offers its kinds, rather than by their names.
  const offered = new Map(connections.map((each) => [each.vendorId, each.resources]))
  const place = ({ vendorId, urlPattern }: ServiceChoice) => offered.get(vendorId)?.findIndex((resource) => resource.urlPattern === urlPattern) ?? 0
  const services = new Map<string, AddableService & { vendorId: string; name: string }>()
  for (const choice of serviceChoices(connections).toSorted((a, b) => place(a) - place(b))) {
    const service = services.get(choice.vendorId)
    if (service) service.kinds.push(choice)
    else services.set(choice.vendorId, { key: choice.vendorId, vendorId: choice.vendorId, name: choice.service.name, service: choice.service, connected: choice.connected, kinds: [choice] })
  }
  const ranked = [...services.values()].toSorted(byServiceRelevance).map(({ vendorId: _, name: __, ...service }): AddableService => service)
  return [...ranked.filter(({ connected }) => connected), alone(MODEL_CHOICE, 'For a gadget to use'), alone(AGENT_CHOICE, 'For a gadget to call on'), ...ranked.filter(({ connected }) => !connected)]
}
