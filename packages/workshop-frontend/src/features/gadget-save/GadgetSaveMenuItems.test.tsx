// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetExportFormat, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'

const testState = vi.hoisted(() => ({
  confirmed: true,
  authenticatedApi: {} as Record<string, unknown>,
}))

vi.mock('@cloudflare/kumo', () => ({
  DropdownMenu: {
    Separator: () => <hr />,
    Item: ({ children, icon, onClick }: { children: ReactNode; icon?: ReactNode; onClick?: () => void }) => (
      <button type="button" onClick={onClick}>{icon}{children}</button>
    ),
  },
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () =>
    ({ currentUser: { id: 'ada@example.com' }, isCurrentUserConfirmed: testState.confirmed }),
  useOptionalAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

import { GadgetSaveMenuItems, useSaveVendors, type SaveRequest } from './GadgetSaveMenuItems'
import { savedFileKey } from './savedFiles'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const vendor = {
  id: 'office',
  description: { displayName: 'Office' },
  supportedResources: [
    { id: 'document', title: 'Office Docs', urlPattern: 'https://office.example/d/*',
      creationConfigurator: true, savableFrom: ['text/html'] },
    { id: 'sheet', title: 'Office Sheets', urlPattern: 'https://office.example/s/*',
      creationConfigurator: true, savableFrom: ['text/csv'] },
  ],
} as GatekeeperVendorInfo
const html: GadgetExportFormat =
  { id: 'html', label: 'HTML', mode: 'server', contentType: 'text/html', fileExtension: '.html' }
const scope = { workspaceId: 'ws', workpieceId: 3 }
const target = { vendor, resource: vendor.supportedResources[0], format: html }
const key = savedFileKey('ada@example.com', scope, target)
const saved = { accountId: 5, url: 'https://office.example/d/1', name: 'Q3 report' }

let root: Root
let container: HTMLDivElement
const onSelect = vi.fn<(request: SaveRequest) => void>()

const render = async (formats: GadgetExportFormat[] = [html], vendors = [vendor]) => {
  await act(async () => root.render(
    <GadgetSaveMenuItems vendors={vendors} formats={formats} scope={scope} onSelect={onSelect} />))
}

const labels = () => [...container.querySelectorAll('button')].map(button => button.textContent)

beforeEach(() => {
  testState.authenticatedApi = {
    listGatekeeperVendors: async () => [vendor],
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  onSelect.mockReset()
  vi.restoreAllMocks()
})

describe('GadgetSaveMenuItems', () => {
  it('offers a save for each type the gadget\'s exports can be saved as', async () => {
    await render()
    expect(labels()).toEqual(['Save to Office Docs…'])

    await act(async () => container.querySelector('button')!.click())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ target, storageKey: key })
  })

  it('draws each save with its type\'s icon, or the service\'s logo', async () => {
    const branded = {
      ...vendor,
      description: { ...vendor.description, logo: { url: 'data:,office' } },
      supportedResources: [vendor.supportedResources[0], { ...vendor.supportedResources[1], icon: { url: 'data:,sheet' } }],
    }
    await render([html, { ...html, id: 'csv', contentType: 'text/csv' }], [branded])
    expect([...container.querySelectorAll('img')].map(img => img.getAttribute('src')))
      .toEqual(['data:,office', 'data:,sheet'])
  })

  it('renders nothing when no type matches', async () => {
    await render([{ ...html, contentType: 'application/pdf' }])
    expect(container.innerHTML).toBe('')
  })

  it('offers to update the file the last save made, above saving a new one', async () => {
    localStorage.setItem(key, JSON.stringify(saved))
    await render()
    expect(labels()).toEqual(['Update “Q3 report”…', 'Save to Office Docs…'])

    await act(async () => container.querySelector('button')!.click())
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ target, storageKey: key, saved })
  })

  it('remembers nothing for a user this connection has yet to confirm', async () => {
    localStorage.setItem(key, JSON.stringify(saved))
    testState.confirmed = false
    try {
      await render()
      expect(labels()).toEqual(['Save to Office Docs…'])
      await act(async () => container.querySelector('button')!.click())
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({ target, storageKey: null })
    } finally {
      testState.confirmed = true
    }
  })

  it('keeps a save to itself: another gadget, workspace or type has nothing to update', async () => {
    localStorage.setItem(savedFileKey('ada@example.com', { ...scope, workspaceId: 'other' }, target),
      JSON.stringify(saved))
    localStorage.setItem(savedFileKey('ada@example.com', { ...scope, workpieceId: 4 }, target),
      JSON.stringify(saved))
    localStorage.setItem(savedFileKey('bob@example.com', scope, target), JSON.stringify(saved))
    localStorage.setItem(
      savedFileKey('ada@example.com', scope, { ...target, resource: vendor.supportedResources[1] }),
      JSON.stringify(saved))
    await render()
    expect(labels()).toEqual(['Save to Office Docs…'])
  })

  it('still offers a save when storage is unreadable or holds something else', async () => {
    localStorage.setItem(key, '{"url": 7}')
    await render()
    expect(labels()).toEqual(['Save to Office Docs…'])

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    await render()
    expect(labels()).toEqual(['Save to Office Docs…'])
  })
})

describe('useSaveVendors', () => {
  const seen: (GatekeeperVendorInfo[] | null)[] = []
  let refresh: () => void
  const Probe = ({ enabled }: { enabled: boolean }) => {
    const listed = useSaveVendors(enabled)
    seen.push(listed.vendors)
    refresh = listed.refresh
    return null
  }
  const down = { ...vendor, unavailable: true } as GatekeeperVendorInfo
  afterEach(() => { seen.length = 0 })

  it('is null until the services are first listed', async () => {
    await act(async () => root.render(<Probe enabled />))
    expect([seen[0], seen.at(-1)]).toEqual([null, [vendor]])
  })

  it('lists them again on a refresh, keeping what it knows until then and through a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listGatekeeperVendors = vi.fn<() => Promise<GatekeeperVendorInfo[]>>()
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([down])
      .mockResolvedValueOnce([vendor]).mockRejectedValueOnce(new Error('offline'))
    testState.authenticatedApi = { listGatekeeperVendors }
    await act(async () => root.render(<Probe enabled />))
    expect(seen.at(-1)).toEqual([])

    for (const known of [[down], [vendor], [vendor]]) {
      const before = seen.at(-1)
      seen.length = 0
      await act(async () => refresh())
      expect([seen[0], seen.at(-1)]).toEqual([before, known])
    }
  })

  it('lets a listing under way serve a refresh', async () => {
    let listed!: (vendors: GatekeeperVendorInfo[]) => void
    const listGatekeeperVendors = vi.fn<() => Promise<GatekeeperVendorInfo[]>>(
      () => new Promise(resolve => { listed = resolve }))
    testState.authenticatedApi = { listGatekeeperVendors }
    await act(async () => root.render(<Probe enabled />))
    await act(async () => refresh())
    await act(async () => listed([vendor]))
    expect(seen.at(-1)).toEqual([vendor])
    expect(listGatekeeperVendors).toHaveBeenCalledOnce()

    await act(async () => refresh())
    expect(listGatekeeperVendors).toHaveBeenCalledTimes(2)
  })

  it('is empty, asking nothing, when the services are not wanted', async () => {
    const listGatekeeperVendors = vi.fn<() => Promise<GatekeeperVendorInfo[]>>()
    testState.authenticatedApi = { listGatekeeperVendors }
    await act(async () => root.render(<Probe enabled={false} />))
    expect(seen.at(-1)).toEqual([])
    expect(listGatekeeperVendors).not.toHaveBeenCalled()
  })
})
