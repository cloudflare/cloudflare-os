import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { narrowList } from '@/components/listView'
import { accessChoices, accountLabel, connectionList, connectionsOf, creationAccountOf, groupedKinds, isGranted, resourceGroups, resourceOfUrl, missingAccess, newAccountOf, unreachableServices, type ConnectedAccount, type Connection } from './connectionList'

const resource = (title: string, grantable = false): SupportedResource => ({ urlPattern: `https://${title.toLowerCase()}.example/*`, title, description: '', grantable })
const vendor = (id: string, displayName: string, rest: Partial<GatekeeperVendorInfo['description']> = {}, supportedResources: SupportedResource[] = []): GatekeeperVendorInfo => ({
  id,
  description: { displayName, url: `https://${id}.example`, ...rest },
  supportedResources,
})

const MAIL = resource('Mail', true)
const CALENDAR = resource('Calendar', true)
const GOOGLE = vendor('google', 'Google', { tagline: 'Draft replies and edit docs' }, [MAIL, CALENDAR, resource('Profile')])
const JIRA = vendor('jira', 'Jira', {}, [resource('Issue')])
const GITHUB = vendor('github', 'GitHub')
const NOTES = vendor('notes', 'Notes', { autoProvisionsAccount: true })
const WIKI = { ...vendor('wiki', 'Wiki'), unavailable: true }

let made = 0
const account = (of: GatekeeperVendorInfo, description: Partial<AccountDescription> = {}, credentialsValid = true): ConnectedAccount => ({
  id: ++made,
  vendorId: of.id,
  vendor: of.description,
  description: { avatar: { url: '' }, ...description },
  supportedResources: of.supportedResources,
  credentialsValid,
})

const WORK = account(GOOGLE, { displayName: 'Ada Lovelace', uniqueName: 'ada@work.example', grantedResourceUrlPatterns: [MAIL.urlPattern] })
const HOME = account(GOOGLE, { uniqueName: 'ada@home.example' })
const STALE = account(JIRA, { uniqueName: 'ada' }, false)
// Its service is no longer on offer.
const OLD = account(vendor('zulip', 'Zulip'), {})
const ACCOUNTS = [WORK, HOME, STALE, OLD]

const ALL = connectionsOf({ vendors: [GOOGLE, JIRA, GITHUB, WIKI], addable: [NOTES], accounts: ACCOUNTS })
const spec = connectionList(ALL)
const names = (connections: Connection[]) => connections.map((connection) => (connection.kind === 'account' ? `${connection.vendor.displayName} (${accountLabel(connection.account.description) ?? '-'})` : connection.vendor.displayName))
const left = (query: string, ...ids: string[]) =>
  names(narrowList(ALL, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }))
const of = (connected: ConnectedAccount) => ALL.find((connection) => connection.kind === 'account' && connection.account === connected) as Connection & { kind: 'account' }

describe('connectionsOf', () => {
  it('lists each account, then each service on offer that could be connected, those signed in to again', () => {
    expect(names(ALL)).toEqual(['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Jira (ada)', 'Zulip (-)', 'Google', 'Jira', 'GitHub', 'Notes'])
  })

  it('does not offer again a service that is added as it is, which has the one account', () => {
    expect(names(connectionsOf({ vendors: [], addable: [NOTES], accounts: [account(NOTES)] }))).toEqual(['Notes (-)'])
  })

  it('leaves out a service that could not be reached, and names it', () => {
    expect(ALL.some(({ vendorId }) => vendorId === 'wiki')).toBe(false)
    expect(unreachableServices([GOOGLE, WIKI])).toEqual(['Wiki'])
  })

  it('lets another account be connected only for a service that is on offer and signed in to', () => {
    expect(of(WORK).takesAnother).toBe(true)
    expect(of(OLD).takesAnother).toBe(false)
    const added = connectionsOf({ vendors: [], addable: [NOTES], accounts: [account(NOTES)] })
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ kind: 'account', takesAnother: false })
  })

  it('offers the kinds of access that are given one by one, and those an account has not been given', () => {
    expect(accessChoices(of(WORK)).map(({ title }) => title)).toEqual(['Mail', 'Calendar'])
    expect(missingAccess(of(WORK)).map(({ title }) => title)).toEqual(['Calendar'])
    // One that does not say what it was given is taken to have it all.
    expect(missingAccess(of(HOME))).toEqual([])
  })
})

describe('connectionList', () => {
  it('groups what needs attention first, then what is connected, then what could be, each by name', () => {
    expect(spec.orders[0].arrange(ALL, 4).map(({ label, entries }) => [label, names(entries.map(({ value }) => value))])).toEqual([
      ['Needs attention', ['Jira (ada)']],
      ['Connected', ['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Zulip (-)']],
      ['Available', ['GitHub', 'Google', 'Jira', 'Notes']],
    ])
  })

  it('lists what could be connected by category, a category with enough a group of its own and the rest gathered after', () => {
    const offered = connectionsOf({
      vendors: [GITHUB, vendor('gitlab', 'GitLab'), vendor('notion', 'Notion'), vendor('linear', 'Linear'), vendor('slack', 'Slack'), vendor('x', 'X'), vendor('abacus', 'Abacus'), JIRA],
      addable: [NOTES],
      accounts: [STALE],
    })
    const arranged = (enough: number) => spec.orders[0].arrange(offered, enough).map(({ label, entries }) => [label, names(entries.map(({ value }) => value))])
    expect(arranged(2)).toEqual([
      ['Needs attention', ['Jira (ada)']],
      // Under the kind each is most: Linear is for developers too, and Slack for getting work done.
      ['Productivity', ['Linear', 'Notion']],
      ['Developer tools', ['GitHub', 'GitLab']],
      // One of a category that has too few, and those of none, such as a service with an account.
      ['More', ['Abacus', 'Jira', 'Notes', 'Slack', 'X']],
    ])
    // As cards, which need fuller groups, no category has enough.
    expect(arranged(4)).toEqual([
      ['Needs attention', ['Jira (ada)']],
      ['Available', ['Abacus', 'GitHub', 'GitLab', 'Jira', 'Linear', 'Notes', 'Notion', 'Slack', 'X']],
    ])
  })

  it('narrows to where a connection stands, taking those as alternatives', () => {
    expect(left('', 'expired')).toEqual(['Jira (ada)'])
    expect(left('', 'available')).toEqual(['Google', 'Jira', 'GitHub', 'Notes'])
    expect(left('', 'expired', 'available')).toEqual(['Jira (ada)', 'Google', 'Jira', 'GitHub', 'Notes'])
    // An account whose sign-in ran out is still connected.
    expect(left('', 'connected')).toHaveLength(4)
  })

  it('narrows to any kind of service a connection is, not only the one it is listed under, taking those as alternatives', () => {
    // Only the kinds that something listed is.
    expect(spec.filters!.filter(({ facet }) => facet === 'category').map(({ label }) => label)).toEqual(['Productivity', 'Communication', 'Developer tools', 'Data and analytics'])
    expect(left('', 'category:data')).toEqual(['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Google'])
    expect(left('', 'category:data', 'category:developer')).toEqual(['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Google', 'GitHub'])
    expect(left('', 'category:developer', 'available')).toEqual(['GitHub'])
  })

  it('has no kinds to narrow to while there is only one', () => {
    expect(connectionList(connectionsOf({ vendors: [GITHUB, vendor('gitlab', 'GitLab')], addable: [], accounts: [] })).filters!.filter(({ facet }) => facet === 'category')).toEqual([])
  })

  it('finds a connection by what its service is for, its category, what it gives access to, and whose account it is', () => {
    expect(left('replies')).toEqual(['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Google'])
    expect(left('developer')).toEqual(['GitHub'])
    expect(left('analytics')).toEqual(['Google (Ada Lovelace · ada@work.example)', 'Google (ada@home.example)', 'Google'])
    expect(left('issue')).toEqual(['Jira (ada)', 'Jira'])
    expect(left('lovelace')).toEqual(['Google (Ada Lovelace · ada@work.example)'])
    expect(left('home.example')).toEqual(['Google (ada@home.example)'])
  })
})

const kind = (urlPattern: string, more: Partial<SupportedResource> = {}) => ({ urlPattern, title: urlPattern, ...more }) as SupportedResource
const accountNumbered = (id: number, vendorId = 'github') => ({ id, vendorId }) as ConnectedAccount

describe('setting up a connection', () => {
  it('offers the kinds shown with the one asked for, not those shown apart', () => {
    // Shown with another by its type's id, which is not its pattern, as Google Drive's are.
    const resources = [kind('https://drive.example/my-drive', { id: 'drive' }), kind('drive/file', { groupedWith: 'drive' }), kind('drive/doc', { groupedWith: 'drive' }), kind('calendar')]
    expect(groupedKinds(resources, 'drive/doc')).toEqual(['https://drive.example/my-drive', 'drive/file', 'drive/doc'])
    expect(resourceGroups(resources).map(({ lead, members }) => [lead.urlPattern, members.length])).toEqual([['https://drive.example/my-drive', 3], ['calendar', 1]])
    expect(groupedKinds(resources, 'calendar')).toEqual(['calendar'])
    expect(groupedKinds(resources, 'unknown')).toEqual(['unknown'])
  })

  it('offers to connect only kinds that can be, not those that can only be made', () => {
    const resources = [kind('drive'), kind('drive/new', { groupedWith: 'drive', connectable: false }), kind('https://*'), kind('slides', { connectable: false })]
    expect(groupedKinds(resources, 'drive')).toEqual(['drive'])
    expect(resourceGroups(resources).map(({ lead }) => lead.urlPattern)).toEqual(['drive', 'https://*'])
    expect(resourceOfUrl([kind('https://docs.example/*', { connectable: false }), kind('https://*')], 'https://docs.example/a')?.urlPattern).toBe('https://*')
  })

  it('takes an account that says nothing of what it may reach to reach everything', () => {
    expect(isGranted(undefined, 'mail')).toBe(true)
    expect(isGranted(['calendar'], 'mail')).toBe(false)
  })

  it('finds the account a connect flow made, not one signed in to again', () => {
    expect(newAccountOf([accountNumbered(1), accountNumbered(2), accountNumbered(3, 'google')], 'github', new Set([1]))?.id).toBe(2)
    expect(newAccountOf([accountNumbered(1)], 'github', new Set([1]))).toBeUndefined()
  })

  it('creates in the only account that can without asking, and asks when there is a choice or none', () => {
    const doc = kind('docs', { grantable: true })
    const able = (id: number, more: Partial<ConnectedAccount> = {}) =>
      ({ id, vendorId: 'google', credentialsValid: true, supportedResources: [doc], description: { grantedResourceUrlPatterns: ['docs'] }, ...more }) as ConnectedAccount
    const ungranted = able(2, { description: { grantedResourceUrlPatterns: [] } as unknown as ConnectedAccount['description'] })
    expect(creationAccountOf([able(1), ungranted, able(3, { credentialsValid: false }), able(4, { vendorId: 'github' })], 'google', 'docs')).toBe(1)
    expect(creationAccountOf([able(1), able(5)], 'google', 'docs')).toBeUndefined()
    expect(creationAccountOf([], 'google', 'docs')).toBeUndefined()
  })
})
