import type { AuthenticatedApi, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { ConnectedAccount } from '@/connections/connectionList'

/** A service offered as the user is set up, to sign in to: once, whatever accounts it takes. */
export type OnboardingService = {
  vendorId: string
  name: string
  logoUrl?: string
  color?: string
  tagline?: string
  /** An account of the user's is connected to it, as one just signed in to is. */
  connected: boolean
}

/**
 * A tool the deployment offers to everyone, which needs nothing signed in to (an ambient
 * gatekeeper such as the Context Library or Scheduled Tasks): turned on as setting up finishes,
 * unless it is switched off.
 */
export type OnboardingTool = Omit<OnboardingService, 'connected'>

export type OnboardingChoices =
  | { status: 'loading' }
  | { status: 'ready'; services: OnboardingService[]; tools: OnboardingTool[] }
  | { status: 'failed'; message: string; retry: () => void }

const listed = ({ id, description }: GatekeeperVendorInfo) => ({
  vendorId: id,
  name: description.displayName || id,
  logoUrl: description.logo?.url,
  color: description.color,
  tagline: description.tagline,
})

// By a service's id (see `serviceCategories.ts`): those most people work in every day first (mail
// and documents, chat, code, tickets), then wikis and notes, then what fewer people use, so that
// the few anyone is likely to connect are at the top of a long list.
const SERVICES_FIRST = [
  'google', 'microsoft', 'slack', 'github', 'gitlab', 'jira', 'confluence', 'cf_wiki', 'notion', 'linear',
  'cloudflare', 'email', 'backstage', 'salesforce', 'workday', 'pagerduty', 'sentry',
]
// What the agent reaches for most, first.
const TOOLS_FIRST = ['websearch', 'context', 'scheduler', 'container']

const byRelevance = (first: string[]) => {
  const rank = (vendorId: string) => {
    const at = first.indexOf(vendorId)
    return at === -1 ? first.length : at
  }
  return (a: { vendorId: string; name: string }, b: { vendorId: string; name: string }) =>
    rank(a.vendorId) - rank(b.vendorId) || a.name.localeCompare(b.name)
}

/**
 * What setting up offers: each service that can be signed in to and can be reached, said to be
 * connected once the user has an account of it; and each tool that is added as it is
 * (`autoProvisionsAccount`) which they do not have yet. The ones most people use first, then the
 * rest by name, an order that a service being connected does not change, so nothing moves under
 * the pointer.
 */
export const onboardingChoicesOf = ({ vendors, addable, accounts }: {
  vendors: GatekeeperVendorInfo[]
  addable: GatekeeperVendorInfo[]
  accounts: ConnectedAccount[]
}) => {
  const had = new Set(accounts.map(({ vendorId }) => vendorId))
  return {
    services: vendors
      .filter(({ unavailable, description }) => !unavailable && !description.autoProvisionsAccount)
      .map((vendor): OnboardingService => ({ ...listed(vendor), connected: had.has(vendor.id) }))
      .toSorted(byRelevance(SERVICES_FIRST)),
    tools: addable
      .filter(({ id, unavailable, description }) => !unavailable && description.autoProvisionsAccount && !had.has(id))
      .map(listed)
      .toSorted(byRelevance(TOOLS_FIRST)),
  }
}

/** A step of setting up: who the user is, then what the app can use on their behalf. */
export type OnboardingStep = 'profile' | 'connections'

/**
 * The steps there are. The connections are one until there is known to be nothing to offer, so
 * that what is offered is seen before anything is turned on.
 */
export const onboardingSteps = (choices: OnboardingChoices): OnboardingStep[] =>
  choices.status === 'ready' && choices.services.length === 0 && choices.tools.length === 0
    ? ['profile']
    : ['profile', 'connections']

/** What finishing asks of the backend. */
export type OnboardingApi = Pick<AuthenticatedApi, 'setOwnDisplayName' | 'provisionAmbientAccount' | 'completeOnboarding'>

/**
 * Finishes setting up: keeps the name, where it was changed, and turns on the tools, then marks the
 * user as set up. A tool is optional, so one that cannot be turned on (an administrator switched it
 * off meanwhile, say) is said, by name, and keeps no one from going on; anything else that fails
 * rejects, with the user still to be set up. Resolves to the name kept, if it was changed.
 */
export const finishOnboarding = async (api: OnboardingApi, { name, previousName, tools }: {
  name: string
  previousName: string
  tools: OnboardingTool[]
}): Promise<{ name?: string; failedTools: string[] }> => {
  const trimmed = name.trim()
  const renamed = trimmed && trimmed !== previousName ? trimmed : undefined
  if (renamed) await api.setOwnDisplayName(renamed)
  const failed = await Promise.all(tools.map(async ({ vendorId, name: toolName }) => {
    try {
      await api.provisionAmbientAccount(vendorId)
      return undefined
    } catch {
      return toolName
    }
  }))
  await api.completeOnboarding()
  return { name: renamed, failedTools: failed.filter((toolName) => toolName !== undefined) }
}
