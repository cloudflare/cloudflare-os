import { describe, expect, it } from 'vitest'
import type { GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { ConnectedAccount } from './ConnectedAccounts'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { accountName, grantedGroups, groupConnections, newAccountOf, resourceGroups, resourceOfUrl, resourcesOf, withGrouped } from './connectionGroups'

const vendor = (id: string, extra: Partial<GatekeeperVendorInfo> & { ambient?: boolean } = {}): GatekeeperVendorInfo => ({
  id,
  description: { displayName: id, url: `https://${id}.example`, autoProvisionsAccount: extra.ambient },
  supportedResources: [],
  unavailable: extra.unavailable,
})

const account = (id: number, vendorId: string, { ambient = false, name }: { ambient?: boolean; name?: string } = {}): ConnectedAccount => ({
  id,
  vendorId,
  description: { avatar: { url: '' }, uniqueName: name },
  vendor: { displayName: vendorId, url: '', autoProvisionsAccount: ambient },
  supportedResources: [],
  credentialsValid: true,
})

describe('groupConnections', () => {
  it('puts what the deployment makes apart from what the user signed in to', () => {
    const groups = groupConnections(
      [account(1, 'github'), account(2, 'scheduler', { ambient: true })],
      [vendor('github'), vendor('slack')],
      [vendor('websearch', { ambient: true })],
    )
    expect(groups.connected.map(({ id }) => id)).toEqual([1])
    expect(groups.builtIn.accounts.map(({ id }) => id)).toEqual([2])
    expect(groups.builtIn.addable.map(({ id }) => id)).toEqual(['websearch'])
    // Another account of a connected service can be connected.
    expect(groups.available.map(({ id }) => id)).toEqual(['github', 'slack'])
  })

  it('leaves out a service that could not be asked, and a built-in one already added', () => {
    const groups = groupConnections(
      [account(2, 'scheduler', { ambient: true })],
      [vendor('github', { unavailable: true })],
      [vendor('scheduler', { ambient: true })],
    )
    expect(groups.available).toEqual([])
    expect(groups.builtIn.addable).toEqual([])
  })

  it('lists a service both lists have once', () => {
    const groups = groupConnections([], [vendor('context', { ambient: true })], [vendor('context', { ambient: true })])
    expect(groups.builtIn.addable.map(({ id }) => id)).toEqual(['context'])
  })
})

describe('accountName', () => {
  it('is the account’s name, unless that is only the service’s', () => {
    expect(accountName(account(1, 'github', { name: 'octocat' }))).toBe('octocat')
    expect(accountName(account(1, 'github', { name: 'github' }))).toBeUndefined()
    expect(accountName(account(1, 'github'))).toBeUndefined()
  })
})

describe('newAccountOf', () => {
  it('finds the account of the service that was not there before', () => {
    const accounts = [account(1, 'github'), account(2, 'slack'), account(3, 'github')]
    expect(newAccountOf(accounts, 'github', new Set([1, 2]))?.id).toBe(3)
    expect(newAccountOf(accounts, 'slack', new Set([1, 2]))).toBeUndefined()
  })
})

const DRIVE = 'https://drive.google.com/'
const FOLDER = 'https://drive.google.com/drive/folders/:folderId'
const FILE = 'https://drive.google.com/file/d/:fileId/view'
const MAIL = 'https://mail.google.com/'
const kind = (urlPattern: string, title: string, extra: Partial<SupportedResource> = {}): SupportedResource =>
  ({ urlPattern, title, description: '', grantable: true, ...extra })
// As Google lists them: a member before its group's lead, which an unrelated kind comes between.
const google = [kind(FOLDER, 'Folder', { groupedWith: DRIVE }), kind(MAIL, 'Mail'), kind(DRIVE, 'Drive'), kind(FILE, 'File', { groupedWith: DRIVE })]

describe('resourceGroups', () => {
  it('shows the kinds grouped with one as one, named after it, in the order each group first comes', () => {
    expect(resourceGroups(google).map(({ lead, members }) => [lead.title, members.map(({ title }) => title)]))
      .toEqual([['Drive', ['Folder', 'Drive', 'File']], ['Mail', ['Mail']]])
  })

  it('names a group after its first other kind when its own is not offered', () => {
    expect(resourceGroups(google.filter(({ title }) => title !== 'Drive'))[0]!.lead.title).toBe('Folder')
  })
})

describe('resourcesOf', () => {
  it('lists a row per group', () => {
    expect(resourcesOf(google).map(({ title }) => title)).toEqual(['Drive', 'Mail'])
  })
})

describe('withGrouped', () => {
  it('asks for every grantable kind in each group chosen', () => {
    expect(withGrouped([...google, kind('https://drive.google.com/x', 'X', { groupedWith: DRIVE, grantable: false })], [DRIVE]))
      .toEqual([FOLDER, DRIVE, FILE])
    expect(withGrouped(google, [MAIL])).toEqual([MAIL])
  })
})

describe('grantedGroups', () => {
  it('counts a group granted once all of its kinds are', () => {
    expect(grantedGroups(google, [DRIVE, MAIL])).toEqual([MAIL])
    expect(grantedGroups(google, [DRIVE, FOLDER, FILE])).toEqual([DRIVE])
    expect(grantedGroups(google, undefined)).toBeUndefined()
  })
})

describe('resourceOfUrl', () => {
  it('finds the kind a chosen URL is of', () => {
    expect(resourceOfUrl(google, 'https://drive.google.com/file/d/abc/view')?.title).toBe('File')
  })
})
