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
const PLAIN = vendor('plain', 'Plain', { logo: undefined })
const OFFERED = [PLAIN, CLOUDFLARE, GOOGLE, LINEAR, SLACK, GITHUB]

const logos = (accounts: ConnectedAccount[], extra: GatekeeperVendorInfo[] = []) =>
  sidebarConnections(connectionsOf({ vendors: OFFERED, addable: [SCHEDULER, ...extra], accounts })).map(({ name }) => name)

describe('sidebarConnections', () => {
  it('shows the services the user has connected, once each, and no more than fit', () => {
    expect(logos([account(LINEAR), account(LINEAR), account(GOOGLE)])).toEqual(['Linear', 'Google'])
    expect(logos([account(LINEAR), account(GOOGLE), account(SLACK), account(GITHUB)])).toEqual(['Linear', 'Google', 'Slack'])
  })

  it('leaves out what comes with the app', () => {
    expect(logos([account(SCHEDULER), account(GOOGLE)])).toEqual(['Google'])
  })

  it('offers the first few with a logo, in the deployment’s order, to someone who has connected nothing, even with only what comes with the app', () => {
    expect(logos([])).toEqual(['Cloudflare', 'Google', 'Linear'])
    expect(logos([account(SCHEDULER)])).toEqual(['Cloudflare', 'Google', 'Linear'])
  })

  it('offers only what the deployment has of them', () => {
    expect(sidebarConnections(connectionsOf({ vendors: [SLACK, GOOGLE], addable: [], accounts: [] })).map(({ name }) => name)).toEqual(['Slack', 'Google'])
  })

  it('shows nothing until the services are read', () => {
    expect(sidebarConnections([])).toEqual([])
  })

  it('draws each from its service', () => {
    expect(sidebarConnections(connectionsOf({ vendors: [GOOGLE], addable: [], accounts: [account(GOOGLE)] }))).toEqual([{ name: 'Google', logoUrl: '/google.svg' }])
  })
})
