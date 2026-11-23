// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ConnectedAccountsSubscriber, GadgetClient, GadgetExportFormat, GatekeeperVendorInfo,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

type Toast = { title: string; variant: string; actions?: { children: string; onClick: () => void }[] }

const testState = vi.hoisted(() => ({
  authenticatedApi: {} as Record<string, unknown>,
  toasts: [] as unknown[],
  // What the configurator's choice waits on, when a test holds it back.
  collecting: undefined as Promise<void> | undefined,
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: (toast: unknown) => testState.toasts.push(toast) }),
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../../ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')
  type Props = {
    frame: { iframeHtml: string } | null
    onCollectResourceUrlChange: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange: (ready: boolean | null) => void
  }
  // Ready as soon as its frame arrives; its choice is a folder named for the frame.
  const ResourceConfiguratorHost = ({ frame, onCollectResourceUrlChange, onSelectionReadyChange }: Props) => {
    useEffect(() => {
      if (!frame) return
      onCollectResourceUrlChange(async () => {
        await testState.collecting
        return `folder of ${frame.iframeHtml}`
      })
      onSelectionReadyChange(true)
    }, [frame, onCollectResourceUrlChange, onSelectionReadyChange])
    return null
  }
  return { default: ResourceConfiguratorHost }
})

import { GadgetSaveDialog } from './GadgetSaveDialog'
import type { SaveRequest } from './GadgetSaveMenuItems'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const vendor = {
  id: 'office',
  description: { displayName: 'Office' },
  supportedResources: [{ id: 'document', title: 'Office Docs', urlPattern: 'https://office.example/d/*',
    creationConfigurator: true, savableFrom: ['text/html'] }],
} as GatekeeperVendorInfo
const format: GadgetExportFormat =
  { id: 'html', label: 'HTML', mode: 'server', contentType: 'text/html', fileExtension: '.html' }
const target = { vendor, resource: vendor.supportedResources[0], format }
const KEY = 'gadget-save:test'
const URL = 'https://office.example/d/1'

// What export() returns: a promise to pipeline into saveFile(), never to settle here.
const exported = Object.assign(new Promise<never>(() => {}), { [Symbol.dispose]: vi.fn<() => void>() })
let then: ReturnType<typeof vi.spyOn>
// Not a vi.fn(), which would itself wait on the promise it returns.
const exports: unknown[][] = []
const gadget = {
  export: (...args: unknown[]) => {
    exports.push(args)
    return exported
  },
} as unknown as RpcStub<GadgetClient>
const startCreationConfigurator = vi.fn<(accountId: number, typeId: string, purpose: string) => Promise<object>>(
  async accountId => ({ iframeHtml: `frame-${accountId}`, ui: {} }))
const saveFile = vi.fn<(...args: unknown[]) => Promise<{ url: string }>>()
const onClose = vi.fn<() => void>()

let root: Root
let container: HTMLDivElement

const render = async (request: SaveRequest) => {
  await act(async () => root.render(
    <GadgetSaveDialog gadget={gadget} gadgetTitle="  Q3 report " chatId={7} request={request} onClose={onClose} />))
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!

const typeName = (value: string) => act(() => {
  const input = document.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

const toasts = () => testState.toasts as Toast[]

beforeEach(() => {
  then = vi.spyOn(exported, 'then')
  saveFile.mockResolvedValue({ url: URL })
  testState.authenticatedApi = {
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      subscriber.add(5, { uniqueName: 'work' } as AccountDescription, {} as VendorDescription, [],
          true, 'office')
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
    startCreationConfigurator,
    saveFile,
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  localStorage.clear()
  testState.toasts = []
  testState.collecting = undefined
  exports.length = 0
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('GadgetSaveDialog saving a new file', () => {
  it('offers no Open action for a URL that is not safe to open', async () => {
    saveFile.mockResolvedValue({ url: 'javascript:alert(1)' })
    await render({ target, storageKey: KEY })

    await act(async () => button('Save').click())

    expect(toasts()).toMatchObject([{ title: 'Saved to Office Docs', variant: 'success' }])
    expect(toasts()[0].actions).toBeUndefined()
  })

  it('connects another account asking for no resource types, leaving that to the configurator', async () => {
    const connectAccount = vi.fn<(vendorId: string, typeIds?: string[]) => Promise<never>>(
      () => new Promise(() => {}))
    testState.authenticatedApi.connectAccount = connectAccount
    await render({ target, storageKey: KEY })

    await act(async () => button('Use another Office account').click())

    expect(connectAccount).toHaveBeenCalledExactlyOnceWith('office', [])
  })

  it('saves the export, unawaited, where the configurator chose under the trimmed name', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    await render({ target, storageKey: KEY })
    expect(document.body.textContent).toContain('Save to Office Docs')
    expect(startCreationConfigurator).toHaveBeenCalledExactlyOnceWith(5, 'document', 'save')

    await act(async () => button('Save').click())

    expect(exports).toEqual([['html', 7]])
    expect(saveFile).toHaveBeenCalledExactlyOnceWith(
      5, 'document', 'folder of frame-5', 'Q3 report', 'text/html', exported)
    expect(saveFile.mock.calls[0][5]).toBe(exported)
    expect(then).not.toHaveBeenCalled()
    expect(exported[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ accountId: 5, url: URL, name: 'Q3 report' })

    expect(toasts()).toMatchObject([{ title: 'Saved to Office Docs', variant: 'success' }])
    toasts()[0].actions![0].onClick()
    expect(open).toHaveBeenCalledExactlyOnceWith(URL, '_blank', 'noopener')
  })

  it('needs a name', async () => {
    await render({ target, storageKey: KEY })
    expect(button('Save').disabled).toBe(false)
    typeName('   ')
    expect(button('Save').disabled).toBe(true)
    typeName('Plan')
    await act(async () => button('Save').click())
    expect(saveFile.mock.calls[0][3]).toBe('Plan')
  })

  it('holds its settings still while a save is sent, and keeps them when it fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail!: (error: Error) => void
    saveFile.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    await render({ target, storageKey: KEY })
    await typeName('Plan')
    const settings = () => document.querySelector('input')!.closest('[inert]')

    // From the click, before the configurator has even answered.
    let collected!: () => void
    testState.collecting = new Promise(resolve => { collected = resolve })
    await act(async () => button('Save').click())
    expect(saveFile).not.toHaveBeenCalled()
    expect(settings()).not.toBeNull()
    testState.collecting = undefined
    await act(async () => collected())
    expect(saveFile).toHaveBeenCalledOnce()
    expect(settings()).not.toBeNull()

    await act(async () => fail(new Error('That folder is read-only.')))
    expect(settings()).toBeNull()
    expect(document.querySelector('input')!.value).toBe('Plan')
    expect(toasts()).toEqual([{ title: 'That folder is read-only.', variant: 'error' }])
    expect(onClose).not.toHaveBeenCalled()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(button('Save').disabled).toBe(false)
  })

  it('saves without storage', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    await render({ target, storageKey: KEY })
    await act(async () => button('Save').click())
    await render({ target, storageKey: null })
    await act(async () => button('Save').click())

    expect(toasts()).toMatchObject([{ variant: 'success' }, { variant: 'success' }])
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('GadgetSaveDialog updating the saved file', () => {
  const saved = { accountId: 5, url: URL, name: 'Q3 report' }
  const MOVED = 'https://office.example/d/2'

  it('replaces the file only once confirmed, without asking where', async () => {
    saveFile.mockResolvedValue({ url: MOVED })
    await render({ target, storageKey: KEY, saved })
    expect(document.body.textContent).toContain('Update “Q3 report”?')
    expect(document.body.textContent).toContain('Suggestions that are pending in it are discarded')
    expect(startCreationConfigurator).not.toHaveBeenCalled()
    expect(saveFile).not.toHaveBeenCalled()

    await act(async () => button('Update').click())

    expect(saveFile).toHaveBeenCalledExactlyOnceWith(5, 'document', URL, 'Q3 report', 'text/html', exported)
    expect(then).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ ...saved, url: MOVED })
    expect(toasts()).toMatchObject([{ title: 'Saved to Office Docs', variant: 'success' }])
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('does nothing when cancelled', async () => {
    await render({ target, storageKey: KEY, saved })
    await act(async () => button('Cancel').click())
    expect(saveFile).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('reports a failed update and keeps the file to update', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    localStorage.setItem(KEY, JSON.stringify(saved))
    saveFile.mockRejectedValueOnce(new Error('The file was deleted.'))
    await render({ target, storageKey: KEY, saved })

    await act(async () => button('Update').click())

    expect(toasts()).toEqual([{ title: 'The file was deleted.', variant: 'error' }])
    expect(onClose).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(saved)
    expect(button('Update').disabled).toBe(false)
  })
})
