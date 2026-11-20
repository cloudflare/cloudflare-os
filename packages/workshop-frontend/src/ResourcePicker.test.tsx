// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, ConnectedAccountsFilter, ConnectedAccountsSubscriber, ConnectFlowStart, GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import ResourcePicker from './ResourcePicker'
import { openConnectWindow } from './connectHandoff'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastAdd = vi.hoisted(() => vi.fn<(toast: { title: string, variant?: string }) => void>())

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: toastAdd }),
}))

vi.mock('./connectHandoff', () => ({
  openConnectWindow: vi.fn<() => Promise<'connected'>>(async () => 'connected'),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const dispose = vi.fn<() => void>()
  const promise = Object.assign(new Promise<T>(next => { resolve = next }), {
    [Symbol.dispose]: dispose,
  })
  return { promise, resolve, dispose }
}

// The picker's row holding `text`: the innermost element that contains it.
const rowOf = (picker: HTMLElement, text: string) =>
  [...picker.querySelectorAll('div')].findLast(div => div.textContent?.includes(text))!

describe('ResourcePicker', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    vi.restoreAllMocks()
    toastAdd.mockClear()
    vi.mocked(openConnectWindow).mockClear()
  })

  it('disposes a pending connected-account subscription on unmount', async () => {
    const pendingSubscription = deferred<{ [Symbol.dispose](): void }>()
    const authenticatedApi = {
      subscribeConnectedAccounts: () => pendingSubscription.promise,
      listGatekeeperVendors: async () => [],
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker
        authenticatedApi={authenticatedApi}
        searchText="https://example.com"
        onSelectAccount={() => {}}
      />,
    ))

    act(() => root!.unmount())
    root = undefined

    expect(pendingSubscription.dispose).toHaveBeenCalledOnce()
  })

  // Renders the picker over one vendor, with each of `accounts` connected to it.
  const renderPicker = async (
    vendor: GatekeeperVendorInfo,
    searchText: string,
    { accounts = [], accountResources, accountVendorIds, onSelectAccount = () => {}, onItems, onRefine, activateRef }: {
      accounts?: AccountDescription[]
      accountResources?: SupportedResource[][]
      accountVendorIds?: string[]
      onSelectAccount?: () => void
      onItems?: ComponentProps<typeof ResourcePicker>['onItems']
      onRefine?: ComponentProps<typeof ResourcePicker>['onRefine']
      activateRef?: ComponentProps<typeof ResourcePicker>['activateRef']
    } = {},
  ) => {
    const authenticatedApi = {
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        for (const [i, account] of accounts.entries()) {
          subscriber.add(i + 1, account, vendor.description,
            accountResources?.[i] ?? vendor.supportedResources, true, accountVendorIds?.[i] ?? vendor.id)
        }
        subscriber.ready()
        return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
      },
      listGatekeeperVendors: async () => [vendor],
    } as unknown as RpcStub<AuthenticatedApi>
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(
      <ResourcePicker authenticatedApi={authenticatedApi} searchText={searchText} onSelectAccount={onSelectAccount} onItems={onItems} onRefine={onRefine} activateRef={activateRef} />,
    ))
    return container
  }

  it.each(['', 'Environment', 'https://example.com/environments/123', 'https://example.com/environments/'])(
    'excludes creation-only resources from account, connection and refinement choices for %j', async searchText => {
      const resource: SupportedResource = {
        urlPattern: 'https://example.com/environments/:id', title: 'Environment', description: '',
        connectable: false, creatable: true,
      }
      const vendor = { id: 'example', description: { displayName: 'Example', url: 'https://example.com' }, supportedResources: [resource] }
      const onItems = vi.fn<NonNullable<ComponentProps<typeof ResourcePicker>['onItems']>>()
      const picker = await renderPicker(vendor, searchText, {
        accounts: [{ displayName: 'alice', avatar: { url: '' } }], onItems, onRefine: () => {},
      })

      expect(picker.textContent).toContain('No matching resources.')
      expect(onItems).toHaveBeenLastCalledWith([])
    },
  )

  it.each(['', 'Environment', 'https://example.com/environments/123'])(
    'offers only accounts supporting connection to the matched type for %j', async searchText => {
      const resource: SupportedResource = {
        urlPattern: 'https://example.com/environments/:id', title: 'Environment', description: '',
      }
      const vendor = { id: 'example', description: { displayName: 'Example', url: 'https://example.com' }, supportedResources: [resource] }
      const accounts = ['creation-only', 'unavailable-type', 'connectable']
        .map(displayName => ({ displayName, avatar: { url: '' } }))
      const onItems = vi.fn<NonNullable<ComponentProps<typeof ResourcePicker>['onItems']>>()
      const onSelectAccount = vi.fn<() => void>()
      const activateRef = { current: null } as NonNullable<ComponentProps<typeof ResourcePicker>['activateRef']>
      const picker = await renderPicker(vendor, searchText, {
        accounts,
        accountResources: [[{ ...resource, connectable: false, creatable: true }], [], [resource]],
        onItems, onSelectAccount, activateRef,
      })

      expect(onItems.mock.lastCall?.[0].filter(item => item.type === 'account')
        .map(item => item.accountId)).toEqual([3])
      expect(picker.textContent).not.toContain('creation-only')
      expect(picker.textContent).not.toContain('unavailable-type')
      expect(picker.textContent).toContain('connectable')

      act(() => activateRef.current!(0))
      const row = [...picker.querySelectorAll('div')]
        .findLast(div => div.textContent?.includes('connectable'))!
      act(() => row.click())
      expect(onSelectAccount).toHaveBeenCalledTimes(2)
      expect(onSelectAccount).toHaveBeenLastCalledWith(3, vendor.id, resource, accounts[2], vendor.description)
    },
  )

  it('scopes a type ID to its vendor even when vendor display names match', async () => {
    const resource = { id: 'repository', urlPattern: 'https://git.example/:repo', title: 'Repository', description: '' }
    const vendor = { id: 'git', description: { displayName: 'Git', url: 'https://git.example' }, supportedResources: [resource] }
    const onItems = vi.fn<NonNullable<ComponentProps<typeof ResourcePicker>['onItems']>>()
    const picker = await renderPicker(vendor, '', {
      accounts: [{ displayName: 'other-account', avatar: { url: '' } }], accountVendorIds: ['other-git'],
      accountResources: [[{ ...resource, urlPattern: 'https://other-git.example/:repo' }]], onItems,
    })
    expect(onItems.mock.lastCall?.[0].filter(item => item.type === 'account')).toEqual([])
    expect(picker.textContent).not.toContain('other-account')
  })

  it('names the placeholder still blocking an account, rather than offering to grant access', async () => {
    const thread: SupportedResource = {
      urlPattern: 'https://chat.google.com/:kind(room|dm)/:spaceId/:threadId{/:messageId}?',
      title: 'Google Chat Thread',
      description: 'One thread',
      grantable: true,
    }
    const vendor = { id: 'google', description: { displayName: 'Google', url: 'https://google.com' }, supportedResources: [thread] }
    // An account that hasn't granted this resource type, so it would otherwise need access.
    const account = { displayName: 'dan@example.com', avatar: { url: '' }, grantedResourceUrlPatterns: [] }
    const onSelectAccount = vi.fn<() => void>()

    const picker = await renderPicker(vendor, 'https://chat.google.com/room/AAQANZZTsQ8/:threadId?cls=7', {
      accounts: [account], onSelectAccount,
    })

    const row = [...picker.querySelectorAll('div')].findLast(div => div.textContent?.includes('dan@example.com'))!
    expect(row.textContent).toContain('Fill in :threadId first')
    expect(row.textContent).not.toContain('Grant access')
    act(() => row.click())
    expect(onSelectAccount).not.toHaveBeenCalled()
  })

  it('lists full matches in the order the gatekeeper declared them', async () => {
    // GitLab declares its merge-request pattern before the project pattern that also matches it.
    const resources: SupportedResource[] = [
      { urlPattern: 'https://gitlab.com/:project+/-/merge_requests/:iid{/*}?', title: 'GitLab Merge Request', description: '' },
      { urlPattern: 'https://gitlab.com/:project+', title: 'GitLab Project', description: '' },
    ]
    const vendor = { id: 'gitlab', description: { displayName: 'GitLab', url: 'https://gitlab.com' }, supportedResources: resources }

    const text = (await renderPicker(vendor, 'https://gitlab.com/group/repo/-/merge_requests/12')).textContent!

    expect(text.indexOf('GitLab Merge Request')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('GitLab Merge Request')).toBeLessThan(text.indexOf('GitLab Project'))
  })

  describe('a vendor that provisions its own account', () => {
    type FeedAccount = {
      id: number
      description: AccountDescription
      vendor: { id: string, description: VendorDescription, supportedResources: SupportedResource[] }
      /** Set for an account the deployment forces, which the feed sends only when asked. */
      forced?: boolean
    }
    type PickerProps = ComponentProps<typeof ResourcePicker>

    // A made-up vendor whose account is minted with no connect flow, and which offers one resource.
    const pages: SupportedResource = {
      urlPattern: 'https://notebook.example/pages', title: 'Notebook pages', description: '',
    }
    const notebook: GatekeeperVendorInfo = {
      id: 'notebook',
      description: { displayName: 'Notebook', url: 'https://notebook.example', autoProvisionsAccount: true },
      supportedResources: [pages],
    }
    const notebookAccount: FeedAccount = {
      id: 7, description: { displayName: 'Ada’s notebook', avatar: { url: '' } }, vendor: notebook,
    }

    // The admin gatekeeper as it describes itself.
    const deployment: SupportedResource = {
      id: 'deployment', urlPattern: 'admin://deployment', title: 'Deployment admin', description: '',
    }
    const admin: GatekeeperVendorInfo = {
      id: 'admin',
      description: { displayName: 'Deployment admin', url: 'https://example.com/admin', autoProvisionsAccount: true },
      supportedResources: [deployment],
    }

    // A vendor whose accounts are connected by a flow.
    const environment: SupportedResource = {
      urlPattern: 'https://example.com/environments/:id', title: 'Environment', description: '',
    }
    const example: GatekeeperVendorInfo = {
      id: 'example',
      description: { displayName: 'Example', url: 'https://example.com' },
      supportedResources: [environment],
    }

    // Renders the picker as the composer mounts it, in URL-input mode over the link being typed,
    // with a feed that sends `accounts` as the backend does: an account the deployment forces goes
    // only to a subscriber that asked for forced accounts.
    const renderOffer = async (vendors: GatekeeperVendorInfo[], link: string, accounts: FeedAccount[] = []) => {
      let subscriber!: ConnectedAccountsSubscriber
      const send = ({ id, description, vendor }: FeedAccount) =>
        subscriber.add(id, description, vendor.description, vendor.supportedResources, true, vendor.id)
      const api = {
        subscribeConnectedAccounts: vi.fn<(next: ConnectedAccountsSubscriber, filter?: ConnectedAccountsFilter) => unknown>(
          (next, filter) => {
            subscriber = next
            for (const account of accounts) {
              if (!account.forced || filter?.includeForcedAutoProvisionedAccounts) send(account)
            }
            subscriber.ready()
            return Object.assign(Promise.resolve(), { [Symbol.dispose]: () => {} })
          }),
        listGatekeeperVendors: async () => vendors,
        provisionAmbientAccount: vi.fn<(vendorId: string) => Promise<void>>(async () => {}),
        connectAccount: vi.fn<(vendorId: string, resourceUrlPatterns?: string[]) => Promise<ConnectFlowStart>>(
          async () => ({ url: 'https://example.com/connect', nonce: 'nonce' })),
      }
      const onSelectAccount = vi.fn<PickerProps['onSelectAccount']>()
      const onRefine = vi.fn<NonNullable<PickerProps['onRefine']>>()
      const onItems = vi.fn<NonNullable<PickerProps['onItems']>>()
      const activateRef = { current: null } as NonNullable<PickerProps['activateRef']>
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => root!.render(
        <ResourcePicker
          authenticatedApi={api as unknown as RpcStub<AuthenticatedApi>}
          searchText={link}
          onSelectAccount={onSelectAccount}
          onRefine={onRefine}
          compact
          onItems={onItems}
          activateRef={activateRef}
        />,
      ))
      return {
        picker: container, api, onSelectAccount, onRefine, activateRef,
        itemTypes: () => onItems.mock.lastCall![0].map(item => item.type),
        sendAccount: (account: FeedAccount) => act(() => send(account)),
      }
    }

    it('asks the feed for the accounts the deployment forces', async () => {
      const { api } = await renderOffer([notebook], pages.urlPattern)

      expect(api.subscribeConnectedAccounts).toHaveBeenCalledOnce()
      expect(api.subscribeConnectedAccounts.mock.calls[0][1]).toEqual({ includeForcedAutoProvisionedAccounts: true })
    })

    it('offers the account alone once the user holds it', async () => {
      const { picker, api, onSelectAccount, activateRef, itemTypes } =
        await renderOffer([notebook], pages.urlPattern, [notebookAccount])

      expect(picker.textContent).toContain('Notebook pages')
      expect(itemTypes()).toEqual(['account'])
      expect(picker.textContent).not.toContain('Add Notebook')
      expect(picker.textContent).not.toContain('Connect new account')

      act(() => rowOf(picker, 'Ada’s notebook').click())
      act(() => activateRef.current!(0))
      expect(onSelectAccount).toHaveBeenCalledTimes(2)
      expect(onSelectAccount.mock.calls[0]).toEqual(
        [7, 'notebook', pages, notebookAccount.description, notebook.description])
      expect(onSelectAccount.mock.calls[1]).toEqual(onSelectAccount.mock.calls[0])
      expect(api.provisionAmbientAccount).not.toHaveBeenCalled()
    })

    it('adds the account with no connect flow when the user has none, then offers it', async () => {
      const { picker, api, onSelectAccount, activateRef, itemTypes, sendAccount } =
        await renderOffer([notebook], pages.urlPattern)

      expect(itemTypes()).toEqual(['connect'])
      expect(picker.textContent).toContain('Add Notebook')
      expect(picker.textContent).not.toContain('Connect new account')

      let finishProvisioning!: () => void
      api.provisionAmbientAccount.mockImplementation(
        () => new Promise<void>(resolve => { finishProvisioning = resolve }))
      act(() => activateRef.current!(0))
      expect(picker.textContent).toContain('Adding…')
      expect(api.provisionAmbientAccount).toHaveBeenCalledExactlyOnceWith('notebook')

      sendAccount(notebookAccount)
      await act(async () => finishProvisioning())
      expect(api.connectAccount).not.toHaveBeenCalled()
      expect(openConnectWindow).not.toHaveBeenCalled()
      expect(itemTypes()).toEqual(['account'])
      expect(picker.textContent).not.toContain('Add Notebook')
      expect(picker.textContent).not.toContain('Adding…')

      act(() => rowOf(picker, 'Ada’s notebook').click())
      expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith(
        7, 'notebook', pages, notebookAccount.description, notebook.description)
    })

    it('reports a refused add and keeps its row', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { picker, api, itemTypes } = await renderOffer([notebook], pages.urlPattern)
      api.provisionAmbientAccount.mockRejectedValueOnce(new Error('Service is disabled.'))

      await act(async () => rowOf(picker, 'Add Notebook').click())

      expect(api.provisionAmbientAccount).toHaveBeenCalledExactlyOnceWith('notebook')
      expect(toastAdd).toHaveBeenCalledExactlyOnceWith({ title: 'Service is disabled.', variant: 'error' })
      expect(itemTypes()).toEqual(['connect'])
      expect(picker.textContent).toContain('Add Notebook')
      expect(picker.textContent).not.toContain('Adding…')
    })

    it('offers an account the deployment forces', async () => {
      const forced: FeedAccount = { ...notebookAccount, forced: true }
      const { picker, api, onSelectAccount, itemTypes } =
        await renderOffer([notebook], pages.urlPattern, [forced])

      expect(picker.textContent).toContain('Notebook pages')
      expect(itemTypes()).toEqual(['account'])
      expect(picker.textContent).not.toContain('Add Notebook')

      act(() => rowOf(picker, 'Ada’s notebook').click())
      expect(onSelectAccount).toHaveBeenCalledExactlyOnceWith(
        7, 'notebook', pages, forced.description, notebook.description)
      expect(api.provisionAmbientAccount).not.toHaveBeenCalled()
    })

    // The admin gatekeeper's resource is not a web URL, so no link names it: the composer finds
    // only `http(s)://` text and sends what was typed on as an `https://` URL.
    it.each([
      'https://', 'https://d', 'https://deployment', 'https://admin://deployment',
      'https://example.com/admin',
    ])('offers no row for a resource that no link names for %j', async link => {
      const account: FeedAccount = {
        id: 3, description: { displayName: 'Deployment admin', uniqueName: 'ada', avatar: { url: '' } },
        vendor: admin, forced: true,
      }
      const { picker, onRefine, activateRef, itemTypes } = await renderOffer([admin], link, [account])

      expect(itemTypes()).toEqual([])
      expect(picker.textContent).toBe('No matching resources.')
      act(() => activateRef.current!(0))
      expect(onRefine).not.toHaveBeenCalled()
    })

    // The backend leaves the vendor out of the list for a user who is not a deployment admin, and
    // for everyone while its mode is "disabled".
    it.each(['https://', 'https://notebook.example/pages', 'https://example.com/environments/1'])(
      'offers nothing of a vendor the backend does not list for %j', async link => {
        const { picker, itemTypes } = await renderOffer([example], link, [{ ...notebookAccount, forced: true }])

        expect(picker.textContent).not.toContain('Notebook')
        expect(picker.textContent).not.toContain('Add ')
        expect(itemTypes()).not.toContain('account')
      },
    )

    it.each(['https://', 'https://example.com/search', 'https://example.com/environments/1'])(
      'adds no row for a forced account that offers no resource for %j', async link => {
        const anyUrl: GatekeeperVendorInfo = {
          id: 'http',
          description: { displayName: 'HTTP', url: 'https://example.com/http' },
          supportedResources: [{ urlPattern: 'https://*', title: 'Any URL', description: '' }],
        }
        const webSearch: FeedAccount = {
          id: 5, description: { displayName: 'Web Search', avatar: { url: '' } }, forced: true,
          vendor: {
            id: 'websearch',
            description: { displayName: 'Web Search', url: 'https://example.com/search', autoProvisionsAccount: true },
            supportedResources: [],
          },
        }
        const { picker, itemTypes } = await renderOffer([example, anyUrl], link, [webSearch])

        expect(picker.textContent).not.toContain('Web Search')
        expect(itemTypes()).not.toContain('account')
      },
    )

    it('keeps the connect flow of a vendor whose accounts are connected', async () => {
      const alice: FeedAccount = { id: 1, description: { displayName: 'alice', avatar: { url: '' } }, vendor: example }
      const { picker, api, itemTypes } =
        await renderOffer([example], 'https://example.com/environments/1', [alice])

      expect(itemTypes()).toEqual(['account', 'connect'])

      await act(async () => rowOf(picker, 'Connect new account').click())
      expect(api.connectAccount).toHaveBeenCalledExactlyOnceWith('example', undefined)
      expect(openConnectWindow).toHaveBeenCalledOnce()
      expect(api.provisionAmbientAccount).not.toHaveBeenCalled()
    })
  })
})
