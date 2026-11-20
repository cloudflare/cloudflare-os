import {
  createOpenWorkspaceError,
  OPEN_WORKSPACE_ERROR_CODES,
  type BlueprintGadgetSummary,
  type ConnectedAccountsSubscriber,
  type ConnectFlowStart,
  type GatekeeperVendorInfo,
  type ObserverAccountChoice,
  type ObserverBindingNeed,
  type ObserverConfigCallback,
  type WorkpiecesSubscriber,
  type WorkspaceMetadataWithTimestamps,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { MockGadget, type Handle } from '@/chat/mock/MockGadget'
import { VIEWER } from '@/chat/mock/scenario'
import type { ApiSession } from '@/rpc/ApiContext'

/** Why the viewer can't simply open the app a link took them to. */
export type NoAccessCase = 'not-invited' | 'link-off' | 'gone' | 'connections' | 'refused'

/** Each case, as the page's switcher lists it. */
export const NO_ACCESS_CASES: { id: NoAccessCase; label: string; description: string }[] = [
  {
    id: 'not-invited',
    label: 'Not invited',
    description: 'A link to an app in a workspace nobody shared with you.',
  },
  {
    id: 'link-off',
    label: 'Link turned off',
    description: 'A shared link the workspace no longer takes: its sharing was turned off, or it holds restricted data. Continue goes on to the app without it, where you have no access.',
  },
  {
    id: 'gone',
    label: 'Deleted',
    description: 'A link to an app whose workspace was deleted.',
  },
  {
    id: 'connections',
    label: 'Needs your connections',
    description: 'Shared with you to use. It reads a dozen things across six services, which you confirm your own accounts can see: you have two Google accounts, of which only the work one can open the budget and the hiring plan; Slack hasn’t been given your channels, Notion has signed you out, and you have no account at GitLab, Jira or Figma yet.',
  },
  {
    id: 'refused',
    label: 'Account refused',
    description: 'As Needs your connections, with everything connected since, once you confirmed with the Google account that can’t open the budget and the hiring plan: asked again, with which. Choose the work account for them to open it.',
  },
]

/** The workspace the link is to, and the app in it. */
export const NO_ACCESS_WORKSPACE_ID = 'planning'
export const NO_ACCESS_GADGET_ID = 7

const GADGET_TITLE = 'Q3 planning'

// What the app shows once it opens: what it read, drawn with no calls to its server side, which
// is all this page needs to show.
const UI_CODE = String.raw`
document.head.insertAdjacentHTML('beforeend', '<style>' + [
  'body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: #1d1d1f; }',
  'main { max-width: 40rem; margin: 0 auto; padding: 40px 32px; }',
  'h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; letter-spacing: -0.02em; }',
  'p { color: #6e6e73; margin: 0 0 24px; }',
  'li { padding: 6px 0; }',
].join('\n') + '</style>')
document.body.innerHTML = '<main><h1>Q3 planning</h1><p>From the Q3 budget and platform/roadmap</p><ul>' +
  '<li>Budget: 82% committed, 18% left for hiring</li>' +
  '<li>Roadmap: 14 of 22 milestones on track</li>' +
  '<li>Next review: the first Monday of the quarter</li></ul></main>'
`

const logo = (letter: string) => ({
  url: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="18" text-anchor="middle" font-family="sans-serif" font-size="18" font-weight="700" fill="white">${letter}</text></svg>`)}`,
})

const kind = (id: string, title: string, description: string, urlPattern: string): SupportedResource => ({ id, title, description, urlPattern, grantable: true })
const service = (id: string, displayName: string, letter: string, color: string, tagline: string, resources: SupportedResource[]): GatekeeperVendorInfo => ({
  id,
  description: { displayName, url: `https://${id}.example`, tagline, logo: logo(letter), color },
  supportedResources: resources,
})

const GOOGLE = service('google', 'Google', 'G', '#4285f4', 'Draft replies, edit docs, and analyze data', [
  kind('docs', 'Google Doc', 'Read and edit your documents', 'https://docs.google.com/document/*'),
  kind('sheets', 'Google Spreadsheet', 'Read and edit your spreadsheets', 'https://docs.google.com/spreadsheets/*'),
  kind('slides', 'Google Slides Presentation', 'Read and edit your presentations', 'https://docs.google.com/presentation/*'),
])
const GITLAB = service('gitlab', 'GitLab', 'L', '#e24329', 'Triage issues, review merge requests, and push to projects', [
  kind('project', 'Project', 'Issues, merge requests and code', 'https://gitlab.com/*'),
])
const SLACK = service('slack', 'Slack', 'S', '#4a154b', 'Read and post in your channels', [
  kind('channel', 'Channel', 'Read and post messages', 'https://slack.com/archives/*'),
])
const NOTION = service('notion', 'Notion', 'N', '#191919', 'Read and edit your pages and databases', [
  kind('page', 'Page', 'Read and edit pages', 'https://notion.so/*'),
])
const JIRA = service('jira', 'Jira', 'J', '#0052cc', 'Track issues and plan sprints', [
  kind('project', 'Project', 'Issues and boards', 'https://jira.example/browse/*'),
])
const FIGMA = service('figma', 'Figma', 'F', '#a259ff', 'Read designs and leave comments', [
  kind('file', 'File', 'Designs and comments', 'https://figma.com/file/*'),
])
const VENDORS = [GOOGLE, GITLAB, SLACK, NOTION, JIRA, FIGMA]

type Account = { id: number; vendor: GatekeeperVendorInfo; description: AccountDescription; valid: boolean }

const accountAt = (id: number, vendor: GatekeeperVendorInfo, displayName: string, granted: string[], valid = true): Account =>
  ({ id, vendor, description: { avatar: { url: '' }, displayName, grantedResourceTypeIds: granted }, valid })

const PERSONAL = accountAt(1, GOOGLE, 'ada@example.com', ['docs', 'sheets', 'slides'])
const WORK = accountAt(2, GOOGLE, 'ada@work.example.com', ['docs', 'sheets', 'slides'])
// Given no channels yet: its row asks for them.
const SLACK_ACCOUNT = accountAt(4, SLACK, 'Ada · Analytical Engines', [])
// Signed out: its row asks to sign in again.
const NOTION_ACCOUNT = accountAt(5, NOTION, 'ada@work.example.com', ['page'], false)
// What connecting each service the viewer has no account at gives them.
const CONNECTED: Record<string, Account> = {
  gitlab: accountAt(3, GITLAB, 'ada', ['project']),
  jira: accountAt(6, JIRA, 'ada@work.example.com', ['project']),
  figma: accountAt(7, FIGMA, 'Ada Lovelace', ['file']),
}

// What the app reads: a doc read by two of its connections, and a dozen more across six services,
// some at services the viewer has no account at.
let lastGatekeeperId = 10
const needOf = (vendorId: string, resourceTitle: string, resourceUrl: string, resourceTypeId: string): ObserverBindingNeed =>
  ({ gatekeeperId: ++lastGatekeeperId, vendorId, resourceTitle, resourceUrl, resourceTypeId })
const BUDGET = needOf('google', 'Q3 budget', 'https://docs.google.com/document/d/q3-budget', 'docs')
const NEEDS: ObserverBindingNeed[] = [
  BUDGET,
  { ...BUDGET, gatekeeperId: ++lastGatekeeperId },
  needOf('google', 'Hiring plan', 'https://docs.google.com/spreadsheets/d/hiring-plan', 'sheets'),
  needOf('google', 'Q3 kickoff deck', 'https://docs.google.com/presentation/d/q3-kickoff', 'slides'),
  needOf('gitlab', 'platform/roadmap', 'https://gitlab.com/platform/roadmap', 'project'),
  needOf('gitlab', 'platform/infrastructure', 'https://gitlab.com/platform/infrastructure', 'project'),
  needOf('slack', '#planning', 'https://slack.com/archives/planning', 'channel'),
  needOf('slack', '#platform-leads', 'https://slack.com/archives/platform-leads', 'channel'),
  needOf('notion', 'Q3 OKRs', 'https://notion.so/q3-okrs', 'page'),
  needOf('notion', 'Team directory', 'https://notion.so/team-directory', 'page'),
  needOf('jira', 'PLAT', 'https://jira.example/browse/PLAT', 'project'),
  needOf('figma', 'Dashboard redesign', 'https://figma.com/file/dashboard-redesign', 'file'),
]
// What only the work account can open, and so what any other is refused for.
const WORK_ONLY = new Set(['Q3 budget', 'Hiring plan'])
const REASON = (title: string) => `“${title}” isn’t shared with this account.`
/** The needs again, with each of the work account's documents confirmed with another account refused. */
const refusedOf = (choices: readonly ObserverAccountChoice[]) => {
  const failed = NEEDS.map((each) => {
    const accountId = choices.find((choice) => choice.gatekeeperId === each.gatekeeperId)?.accountId
    return WORK_ONLY.has(each.resourceTitle) && accountId !== undefined && accountId !== WORK.id
      ? { ...each, failure: { accountId, reason: REASON(each.resourceTitle) } }
      : each
  })
  return failed.some(({ failure }) => failure) ? failed : undefined
}

const TEMPLATE = { id: 'q3-planning', title: 'Q3 planning', description: 'A quarter’s budget, roadmap and reviews on one page', version: 1 } as BlueprintGadgetSummary

// What a connect flow starts, as the scripted chats' does: the window opened for it stays empty,
// and the account is there a moment later.
const FLOW: ConnectFlowStart = { url: 'about:blank', nonce: '0'.repeat(64) }
const CONNECT_TIME = 800

const own = (id: string, title: string, hoursAgo: number): WorkspaceMetadataWithTimestamps => ({
  id,
  title,
  created: new Date(0),
  lastActive: new Date(Date.now() - hoursAgo * 3_600_000),
})

const lease = () => Object.assign(Promise.resolve({ [Symbol.dispose]: () => {} }), { [Symbol.dispose]: () => {} })
const refusal = (error: Error) => {
  const promise = Promise.reject(error)
  promise.catch(() => {})
  return Object.assign(promise, { [Symbol.dispose]: () => {} })
}

/**
 * A signed-in API for one case: the viewer's own workspaces, and the one the link is to, which
 * refuses them as the backend does, or asks them to confirm their access through the
 * `ObserverConfigCallback` the app hands every open (`ObserverAccessProvider`). Confirmed, the app
 * opens, as the scripted chats' gadget. Any other call throws, so that a screen that starts
 * depending on more says so.
 */
export const createNoAccessApi = (which: NoAccessCase, { template = true }: { template?: boolean } = {}): ApiSession => {
  const asks = which === 'connections' || which === 'refused'
  // Asked again, the viewer has connected and signed in to everything since.
  const had = which === 'refused'
    ? [PERSONAL, WORK, ...Object.values(CONNECTED), { ...SLACK_ACCOUNT, description: { ...SLACK_ACCOUNT.description, grantedResourceTypeIds: ['channel'] } }, { ...NOTION_ACCOUNT, valid: true }]
    : [PERSONAL, WORK, SLACK_ACCOUNT, NOTION_ACCOUNT]
  const accounts = new Map<number, Account>(had.map((each) => [each.id, each]))
  const subscribers = new Set<ConnectedAccountsSubscriber>()
  const tell = (subscriber: ConnectedAccountsSubscriber, { id, vendor, description, valid }: Account) =>
    subscriber.add(id, description, vendor.description, vendor.supportedResources, valid, vendor.id)
  const add = (account: Account) => {
    accounts.set(account.id, account)
    for (const subscriber of subscribers) tell(subscriber, account)
  }
  let confirmed = false
  // What the viewer is asked first: in `refused`, why the account they confirmed with was refused.
  const firstNeeds = which === 'refused' ? refusedOf(NEEDS.map(({ gatekeeperId }) => ({ gatekeeperId, accountId: PERSONAL.id })))! : NEEDS
  const failure = which === 'gone'
    ? createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.workspaceNotFound)
    : createOpenWorkspaceError(OPEN_WORKSPACE_ERROR_CODES.workspaceAccessDenied)
  const gadget = new MockGadget(GADGET_TITLE, async () => {}, () => UI_CODE)

  // As a collaborator who may only use it, the viewer is verified for the gadget as they get it,
  // and asked again for what was refused until each account will do.
  const authorize = async (configure: ObserverConfigCallback | undefined) => {
    if (!asks) throw failure
    if (confirmed) return
    if (!configure) throw new Error(`No such gadget: ${NO_ACCESS_GADGET_ID}`)
    let needs = firstNeeds
    for (;;) {
      const choices = await configure.configure(needs)
      const again = refusedOf(choices)
      if (again) {
        needs = again
        continue
      }
      confirmed = true
      return
    }
  }

  const open = () => {
    const handle: Handle = { onBroken: new Set() }
    return {
      getGadget: (_id: number, configure?: ObserverConfigCallback) => {
        const opened = gadget.open(handle)
        return {
          ...opened,
          getUiBundle: async (chatId?: number) => {
            await authorize(configure)
            return opened.getUiBundle(chatId)
          },
          // What it is bound to is its workspace's to say, to whoever builds there.
          listBindings: async () => {
            if (!asks) throw failure
            return []
          },
        }
      },
      // A collaborator who may use it is told of the gadgets shared with them, before they are verified for one.
      subscribeToWorkpieces: (subscriber: WorkpiecesSubscriber) => {
        if (!asks) return refusal(failure)
        subscriber.entry({ id: NO_ACCESS_GADGET_ID, type: 'gadget', title: GADGET_TITLE, commitId: 'kept' })
        subscriber.ready()
        return lease()
      },
      // The template made from it, which the backend tells only whoever builds there: offered as
      // it would be to whoever can't open the app, were it told to them too.
      listBlueprints: async () => (template ? [TEMPLATE] : []),
      subscribeToChat: () => (asks ? lease() : refusal(failure)),
      subscribeToPresence: () => (asks ? lease() : refusal(failure)),
      onRpcBroken: () => {},
      [Symbol.dispose]: () => {},
    }
  }

  const workspaces: WorkspaceMetadataWithTimestamps[] = [
    own('notes', 'Engineering notes', 4),
    own('paris', 'Paris slides', 50),
    ...(asks ? [{ ...own(NO_ACCESS_WORKSPACE_ID, 'Planning', 1), owner: { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' }, role: 'use' } satisfies WorkspaceMetadataWithTimestamps] : []),
  ]

  const implemented: Record<string | symbol, unknown> = {
    listWorkspaces: async () => workspaces,
    openWorkspace: open,
    listGatekeeperVendors: async () => VENDORS,
    // The templates the user has, for the store the offer's is read through: none of their own.
    listFeaturedBlueprints: async () => [],
    listLibraryBlueprints: async () => [],
    listOwnBlueprints: async () => [],
    listAddableGatekeepers: async () => [],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscribers.add(subscriber)
      for (const account of accounts.values()) tell(subscriber, account)
      subscriber.ready()
      return Object.assign(Promise.resolve({ [Symbol.dispose]: () => {} }), { [Symbol.dispose]: () => void subscribers.delete(subscriber) })
    },
    connectAccount: async (vendorId: string) => {
      const connected = CONNECTED[vendorId]
      if (!connected) throw new Error(`not mocked: connecting ${vendorId}`)
      setTimeout(() => add(connected), CONNECT_TIME)
      return FLOW
    },
    reconnectAccount: async (accountId: number) => {
      const account = accounts.get(accountId)
      if (account) setTimeout(() => add({ ...account, valid: true }), CONNECT_TIME)
      return FLOW
    },
    // Given at once, with nothing to sign in to.
    ensureAccountResources: async () => null,
  }
  const api = new Proxy(implemented, {
    get: (target, name) => {
      if (name in target || typeof name === 'symbol' || name === 'then') return target[name]
      return () => {
        throw new Error(`not mocked: ${name}`)
      }
    },
  })
  return { api: api as unknown as ApiSession['api'], user: VIEWER, userChanged: () => {}, reconnecting: false }
}
