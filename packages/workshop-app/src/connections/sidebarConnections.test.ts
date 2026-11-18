import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import { connectionsOf, type ConnectedAccount } from './connectionList'
import { sidebarConnections } from './sidebarConnections'

const vendor = (id: string, displayName: string, rest: Partial<GatekeeperVendorInfo['description']> = {}): GatekeeperVendorInfo => ({
  id,
  description: { displayName, url: `https://${id}.example`, logo: { url: `/${id}.svg` }, ...rest },
  supportedResources: [],
})

let made = 0
const account = (of: GatekeeperVendorInfo): ConnectedAccount => ({
  id: ++made,
  vendorId: of.id,
  vendor: of.description,
  description: { avatar: { url: '' } },
  supportedResources: [],
  credentialsValid: true,
})

const CLOUDFLARE = vendor('cloudflare', 'Cloudflare')
const GOOGLE = vendor('google', 'Google')
const LINEAR = vendor('linear', 'Linear')
const SLACK = vendor('slack', 'Slack')
const GITHUB = vendor('github', 'GitHub')
const SCHEDULER = vendor('scheduler', 'Scheduled Tasks', { autoProvisionsAccount: true })
const HTTP = vendor('http', 'HTTP')
const OFFERED = [CLOUDFLARE, GOOGLE, LINEAR, SLACK, GITHUB, HTTP]

const logos = (accounts: ConnectedAccount[], extra: GatekeeperVendorInfo[] = []) =>
  sidebarConnections(connectionsOf({ vendors: OFFERED, addable: [SCHEDULER, ...extra], accounts })).map(({ name }) => name)

describe('sidebarConnections', () => {
  it('shows the services the user has connected, once each, and no more than fit', () => {
    expect(logos([account(LINEAR), account(LINEAR), account(GOOGLE)])).toEqual(['Linear', 'Google'])
    expect(logos([account(LINEAR), account(GOOGLE), account(SLACK), account(GITHUB)])).toEqual(['Linear', 'Google', 'Slack'])
  })

  it('leaves out what comes with the app', () => {
    expect(logos([account(SCHEDULER), account(HTTP), account(GOOGLE)])).toEqual(['Google'])
  })

  it('offers the best known to someone who has connected nothing, even with only what comes with the app', () => {
    expect(logos([])).toEqual(['Google', 'Cloudflare', 'GitHub'])
    expect(logos([account(SCHEDULER)])).toEqual(['Google', 'Cloudflare', 'GitHub'])
  })

  it('offers only what the deployment has of them', () => {
    expect(sidebarConnections(connectionsOf({ vendors: [SLACK, GOOGLE], addable: [], accounts: [] })).map(({ name }) => name)).toEqual(['Google', 'Slack'])
  })

  it('shows nothing until the services are read', () => {
    expect(sidebarConnections([])).toEqual([])
  })

  it('marks a logo that is much wider than it is tall, and no other', () => {
    const [google, cloudflare] = sidebarConnections(connectionsOf({ vendors: [GOOGLE, CLOUDFLARE], addable: [], accounts: [] }))
    expect(google.wide).toBeUndefined()
    expect(cloudflare.wide).toBe(true)
  })

  it('draws each from its service', () => {
    expect(sidebarConnections(connectionsOf({ vendors: [GOOGLE], addable: [], accounts: [account(GOOGLE)] }))).toEqual([{ name: 'Google', logoUrl: '/google.svg' }])
  })
})
