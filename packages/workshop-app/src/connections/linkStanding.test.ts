import { describe, expect, it } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedAccount, Connection } from './connectionList'
import { linkAccountOf, linkStanding } from './linkStanding'

const DOC = 'https://docs.google.com/document/d/:docId/*'
const SHEET = 'https://docs.google.com/spreadsheets/d/:sheetId/*'
const DOC_URL = 'https://docs.google.com/document/d/1abc/edit'
const kind = (urlPattern: string, extra: Partial<SupportedResource> = {}): SupportedResource => ({ urlPattern, title: urlPattern, description: '', ...extra })
const GOOGLE = [kind(DOC, { title: 'Google Doc', grantable: true }), kind(SHEET, { title: 'Google Sheet', grantable: true }), kind('https://*')]
const GITHUB = [kind('https://github.com/:owner/:repo', { title: 'Repository' })]

const vendor = (name: string, auto = false) => ({ displayName: name, ...(auto ? { autoProvisionsAccount: true } : {}) }) as Connection['vendor']
const service = (vendorId: string, resources: SupportedResource[], auto = false): Connection =>
  ({ kind: 'service', key: `service:${vendorId}`, vendorId, vendor: vendor(vendorId, auto), resources })
const account = (id: number, vendorId: string, resources: SupportedResource[], extra: { granted?: string[]; valid?: boolean; auto?: boolean } = {}): Connection => ({
  kind: 'account',
  key: `account:${id}`,
  vendorId,
  vendor: vendor(vendorId, extra.auto),
  resources,
  takesAnother: true,
  account: {
    id,
    vendorId,
    vendor: vendor(vendorId, extra.auto),
    description: { displayName: `${vendorId} ${id}`, ...(extra.granted ? { grantedResourceUrlPatterns: extra.granted } : {}) } as ConnectedAccount['description'],
    supportedResources: resources,
    credentialsValid: extra.valid ?? true,
  },
})

describe('linkStanding', () => {
  it('finds the service that knows a link as a kind of its own, and nothing for any other web page', () => {
    expect(linkStanding([service('google', GOOGLE), service('github', GITHUB)], DOC_URL)).toMatchObject({ vendorId: 'google', resource: { title: 'Google Doc' }, accounts: [] })
    expect(linkStanding([service('google', GOOGLE)], 'https://example.com/page')).toBeUndefined()
    expect(linkStanding([], DOC_URL)).toBeUndefined()
  })

  it('asks a new account for the kinds given one by one that the link is shown with', () => {
    expect(linkStanding([service('google', GOOGLE)], DOC_URL)?.asks).toEqual([DOC])
    expect(linkStanding([service('github', GITHUB)], 'https://github.com/cloudflare/gadgets')?.asks).toEqual([])
  })

  it('says of each account what it needs first, with those that need nothing before the rest', () => {
    const standing = linkStanding([account(1, 'google', GOOGLE, { valid: false }), account(2, 'google', GOOGLE, { granted: [SHEET] }), account(3, 'google', GOOGLE, { granted: [DOC] }), service('google', GOOGLE)], DOC_URL)
    expect(standing?.accounts.map(({ account: { id }, needs }) => [id, needs])).toEqual([
      [3, undefined],
      [1, { kind: 'signIn' }],
      [2, { kind: 'access', patterns: [DOC] }],
    ])
  })

  it('leaves alone a link whose service the deployment sets up itself', () => {
    expect(linkStanding([account(1, 'google', GOOGLE, { auto: true }), service('google', GOOGLE, true)], DOC_URL)).toBeUndefined()
  })

  it('takes the service the user can use soonest where more than one knows the link', () => {
    const mirror = [kind('https://docs.google.com/*', { title: 'Mirror page' })]
    expect(linkStanding([service('mirror', mirror), account(1, 'google', GOOGLE)], DOC_URL)?.vendorId).toBe('google')
    expect(linkStanding([account(2, 'mirror', mirror, { valid: false }), account(1, 'google', GOOGLE)], DOC_URL)?.vendorId).toBe('google')
  })
})

const through = (connections: Connection[], chosen?: number) => linkAccountOf(linkStanding(connections, DOC_URL)!, chosen)?.account.id

describe('linkAccountOf', () => {
  it('goes through the only account that can take it as it is', () => {
    expect(through([account(1, 'google', GOOGLE, { granted: [] }), account(2, 'google', GOOGLE, { granted: [DOC] })])).toBe(2)
  })

  it('goes through the only account there is, whatever it needs, so that it can say so', () => {
    expect(through([account(1, 'google', GOOGLE, { valid: false })])).toBe(1)
  })

  it('leaves the choice to the user where several could take it, or none of several can, and takes theirs', () => {
    const two = [account(1, 'google', GOOGLE), account(2, 'google', GOOGLE)]
    expect(through(two)).toBeUndefined()
    expect(through(two, 2)).toBe(2)
    expect(through([account(1, 'google', GOOGLE, { valid: false }), account(2, 'google', GOOGLE, { granted: [] })])).toBeUndefined()
    expect(through([service('google', GOOGLE)])).toBeUndefined()
  })
})
