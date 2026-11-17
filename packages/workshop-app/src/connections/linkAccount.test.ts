import { describe, expect, it } from 'vitest'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import type { ConnectedAccount } from './connectionList'
import { linkAccount } from './linkAccount'

const DOC = 'https://docs.google.com/document/d/:docId/*'
const DOC_URL = 'https://docs.google.com/document/d/1abc/edit'
const resource = (urlPattern: string, extra: Partial<SupportedResource> = {}): SupportedResource =>
  ({ urlPattern, title: urlPattern, description: '', ...extra })
const account = (id: number, vendorId: string, resources: SupportedResource[], extra: { granted?: string[]; valid?: boolean; auto?: boolean } = {}): ConnectedAccount => ({
  id,
  vendorId,
  description: { displayName: `${vendorId} ${id}`, ...(extra.granted ? { grantedResourceUrlPatterns: extra.granted } : {}) } as ConnectedAccount['description'],
  vendor: { displayName: vendorId, ...(extra.auto ? { autoProvisionsAccount: true } : {}) } as ConnectedAccount['vendor'],
  supportedResources: resources,
  credentialsValid: extra.valid ?? true,
})
const google = (id: number, extra: Parameters<typeof account>[3] = {}) =>
  account(id, 'google', [resource(DOC, { title: 'Google Doc', grantable: true }), resource('https://*')], extra)

describe('linkAccount', () => {
  it('connects a link through the one account that knows it as a kind of its own', () => {
    expect(linkAccount([google(1), account(2, 'github', [resource('https://github.com/:owner/:repo')])], DOC_URL))
      .toMatchObject({ account: { id: 1 }, resource: { title: 'Google Doc' } })
  })

  it('leaves a link no account knows, or knows only as any web page, as it was written', () => {
    expect(linkAccount([google(1)], 'https://example.com/page')).toBeUndefined()
    expect(linkAccount([], DOC_URL)).toBeUndefined()
  })

  it('chooses among several accounts the one given access to that kind, and none where more than one is', () => {
    expect(linkAccount([google(1, { granted: [] }), google(2, { granted: [DOC] })], DOC_URL)).toMatchObject({ account: { id: 2 } })
    expect(linkAccount([google(1), google(2)], DOC_URL)).toBeUndefined()
  })

  it('tries the only one even without access, so that its refusal says what it lacks', () => {
    expect(linkAccount([google(1, { granted: [] })], DOC_URL)).toMatchObject({ account: { id: 1 } })
  })

  it('skips an account signed out, and one the deployment set up', () => {
    expect(linkAccount([google(1, { valid: false })], DOC_URL)).toBeUndefined()
    expect(linkAccount([google(1, { auto: true })], DOC_URL)).toBeUndefined()
  })
})
