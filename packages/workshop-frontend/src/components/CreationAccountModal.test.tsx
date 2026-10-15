// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ConnectedAccountsSubscriber, ConnectFlowStart, CreationApproval, Overseer,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

type Frame = { iframeHtml: string }

const readFrame = (frame: Frame) => Promise.resolve(`settings from ${frame.iframeHtml}`)

const testState = vi.hoisted(() => ({
  authenticatedApi: {} as Record<string, unknown>,
  // Reports readiness from the mounted configurator frame, if any.
  reportReady: null as ((ready: boolean) => void) | null,
  collect: null as ((frame: Frame) => Promise<string>) | null,
  toasts: [] as unknown[],
  subscriber: null as ConnectedAccountsSubscriber | null,
  // The mounted configurator's access-request handler, and how many configurators have mounted.
  ensureResources: null as ((patterns: string[]) => Promise<boolean>) | null,
  mounts: 0,
}))

const { openConnectWindow } = vi.hoisted(() => ({
  openConnectWindow: vi.fn<(flow: ConnectFlowStart, api: unknown) => Promise<'opened' | 'connected'>>(),
}))

vi.mock('../connectHandoff', () => ({ openConnectWindow }))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: (toast: unknown) => testState.toasts.push(toast) }),
}))

vi.mock('../AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: testState.authenticatedApi }),
}))

vi.mock('../ResourceConfiguratorHost', async () => {
  const { useEffect, useLayoutEffect } = await import('react')

  type Callbacks = {
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    onEnsureResources?: (patterns: string[]) => Promise<boolean>
  }

  // Like SandboxedResourceConfigurator: readiness resets when a frame mounts and unmounts, and the
  // collector reads the mounted frame.
  const Configurator = ({ frame, onCollectResourceUrlChange, onSelectionReadyChange, onEnsureResources }:
    Callbacks & { frame: Frame }) => {
    useEffect(() => { testState.mounts++ }, [])
    useEffect(() => {
      testState.ensureResources = onEnsureResources ?? null
      return () => { testState.ensureResources = null }
    }, [onEnsureResources])
    useLayoutEffect(() => {
      onSelectionReadyChange?.(null)
      testState.reportReady = ready => onSelectionReadyChange?.(ready)
      return () => {
        testState.reportReady = null
        onSelectionReadyChange?.(null)
      }
    }, [frame, onSelectionReadyChange])
    useEffect(() => {
      onCollectResourceUrlChange?.(() => testState.collect!(frame))
      return () => onCollectResourceUrlChange?.(null)
    }, [frame, onCollectResourceUrlChange])
    return null
  }

  const ResourceConfiguratorHost = ({ frame, frameKey, loading, error, ...callbacks }: Callbacks & {
    frame: Frame | null
    frameKey: number | null
    loading: boolean
    error: string | null
  }) => {
    if (loading) return null
    if (error) return <p>{error}</p>
    if (!frame) return null
    return <Configurator key={frameKey} frame={frame} {...callbacks} />
  }

  return { default: ResourceConfiguratorHost }
})

import { CreationAccountModal } from './CreationAccountModal'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const PATTERN = 'https://docs.google.com/document/d/*'

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void }

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Each startCreationConfigurator call, in order, settled by the test.
type Start = { accountId: number; frame: Deferred<object>; disposed: number }
let starts: Start[] = []

const ensureAccountResources =
  vi.fn<(accountId: number, patterns: string[]) => Promise<ConnectFlowStart | null>>()

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  container?.remove()
  starts = []
  testState.authenticatedApi = {}
  testState.reportReady = null
  testState.collect = null
  testState.toasts = []
  testState.subscriber = null
  testState.ensureResources = null
  testState.mounts = 0
  ensureAccountResources.mockReset()
  openConnectWindow.mockReset()
})

async function renderModal() {
  testState.collect = readFrame
  const startCreationConfigurator = vi.fn<(accountId: number) => Promise<object>>(accountId => {
    const frame = deferred<object>()
    starts.push({ accountId, frame, disposed: 0 })
    return frame.promise
  })
  testState.authenticatedApi = {
    listGatekeeperVendors: async () => [{
      id: 'google',
      description: { displayName: 'Google' },
      supportedResources: [{ urlPattern: PATTERN, creatable: true, creationConfigurator: true }],
    }],
    subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
      testState.subscriber = subscriber
      subscriber.add(5, { uniqueName: 'work' } as AccountDescription, {} as VendorDescription, [],
          true, 'google')
      subscriber.add(6, { uniqueName: 'home' } as AccountDescription, {} as VendorDescription, [],
          true, 'google')
      subscriber.ready()
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
    startCreationConfigurator,
    ensureAccountResources,
  }
  const overseer = {
    getGatekeeperById: async () => ({
      getCreationSpec: async () => ({ type: 'gatekeeper', vendorId: 'google', typeUrlPattern: PATTERN }),
      [Symbol.dispose]: () => {},
    }),
  } as unknown as RpcStub<Overseer>
  const onChoose = vi.fn<(creation: CreationApproval) => void>()
  const onCancel = vi.fn<() => void>()

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <CreationAccountModal overseer={overseer} gatekeeperId={7} onChoose={onChoose} onCancel={onCancel} />,
  ))
  return { startCreationConfigurator, onChoose, onCancel }
}

const unmount = () => {
  act(() => root!.unmount())
  root = undefined
}

const resolveStart = async (index: number) => {
  const start = starts[index]
  await act(async () => start.frame.resolve({
    iframeHtml: `frame-${start.accountId}`,
    ui: { [Symbol.dispose]: () => { start.disposed++ } },
  }))
}

const button = (matches: (button: HTMLButtonElement) => boolean) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(matches)!
const approveButton = () => button(b => b.textContent === 'Approve')
const accountButton = (name: string) => button(b => b.textContent?.startsWith(name) ?? false)

const reportReady = () => act(() => testState.reportReady!(true))

describe('CreationAccountModal', () => {
  it('approves with the configuration from the selected account\'s configurator', async () => {
    const { startCreationConfigurator, onChoose } = await renderModal()
    expect(startCreationConfigurator).toHaveBeenLastCalledWith(5, PATTERN)
    await act(async () => accountButton('home').click())
    expect(startCreationConfigurator).toHaveBeenLastCalledWith(6, PATTERN)
    await resolveStart(0)
    await resolveStart(1)
    reportReady()

    await act(async () => approveButton().click())

    expect(onChoose).toHaveBeenCalledWith({ accountId: 6, configuration: 'settings from frame-6' })
  })

  it('enables Approve only once the selected account\'s configurator reports ready', async () => {
    await renderModal()
    await resolveStart(0)
    expect(approveButton().disabled).toBe(true)
    reportReady()
    expect(approveButton().disabled).toBe(false)

    await act(async () => accountButton('home').click())
    expect(approveButton().disabled).toBe(true)
    await resolveStart(1)
    expect(approveButton().disabled).toBe(true)
    reportReady()
    expect(approveButton().disabled).toBe(false)
  })

  it('disposes a configurator frame when its account is switched away or the dialog closes', async () => {
    await renderModal()
    await resolveStart(0)

    await act(async () => accountButton('home').click())
    expect(starts[0].disposed).toBe(1)
    await resolveStart(1)
    expect(starts[1].disposed).toBe(0)

    unmount()
    expect(starts[1].disposed).toBe(1)
  })

  it('disposes a configurator frame that starts after its account was switched away', async () => {
    await renderModal()
    await act(async () => accountButton('home').click())
    await resolveStart(0)
    expect(starts[0].disposed).toBe(1)
  })

  it('disposes a configurator frame that starts after the dialog closed', async () => {
    await renderModal()
    unmount()
    await resolveStart(0)
    expect(starts[0].disposed).toBe(1)
  })

  it('shows why the configurator could not start and keeps Approve disabled', async () => {
    await renderModal()
    await act(async () => starts[0].frame.reject(new Error('No such account.')))

    expect(document.body.textContent).toContain('No such account.')
    expect(approveButton().disabled).toBe(true)
  })

  it('reports a failed collect and lets the approver retry', async () => {
    const collect = deferred<string>()
    const { onChoose } = await renderModal()
    testState.collect = () => collect.promise
    await resolveStart(0)
    reportReady()

    act(() => approveButton().click())
    expect(approveButton().disabled).toBe(true)
    await act(async () => collect.reject(new Error('timed out')))

    expect(testState.toasts).toHaveLength(1)
    expect(onChoose).not.toHaveBeenCalled()
    expect(approveButton().disabled).toBe(false)
  })

  it('ignores a collect still pending when the dialog is cancelled', async () => {
    const collect = deferred<string>()
    const { onChoose, onCancel } = await renderModal()
    testState.collect = () => collect.promise
    await resolveStart(0)
    reportReady()

    act(() => approveButton().click())
    act(() => button(b => b.textContent === 'Cancel').click())
    expect(onCancel).toHaveBeenCalled()
    unmount()
    // Disposing the frame shuts down its session, rejecting the pending collect.
    await act(async () => collect.reject(new Error('RPC session was shut down')))

    expect(testState.toasts).toHaveLength(0)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('ignores a collect still pending when the account is switched', async () => {
    const collect = deferred<string>()
    const { onChoose } = await renderModal()
    testState.collect = frame => frame.iframeHtml === 'frame-5' ? collect.promise : readFrame(frame)
    await resolveStart(0)
    reportReady()

    act(() => approveButton().click())
    await act(async () => accountButton('home').click())
    await act(async () => collect.resolve('settings from frame-5'))
    expect(testState.toasts).toHaveLength(0)
    expect(onChoose).not.toHaveBeenCalled()

    await resolveStart(1)
    reportReady()
    await act(async () => approveButton().click())
    expect(onChoose).toHaveBeenCalledExactlyOnceWith(
      { accountId: 6, configuration: 'settings from frame-6' })
  })
})

describe('CreationAccountModal configurator access requests', () => {
  const IMPORT_GRANT = 'https://drive.google.com/file/d/*'

  it('resolves true without a pop-up when the account already holds the grants', async () => {
    ensureAccountResources.mockResolvedValue(null)
    await renderModal()
    await resolveStart(0)

    await expect(testState.ensureResources!([IMPORT_GRANT])).resolves.toBe(true)

    expect(ensureAccountResources).toHaveBeenCalledExactlyOnceWith(5, [IMPORT_GRANT])
    expect(openConnectWindow).not.toHaveBeenCalled()
    expect(testState.toasts).toEqual([])
  })

  it('asks for the account the configurator was started on', async () => {
    ensureAccountResources.mockResolvedValue(null)
    const { startCreationConfigurator } = await renderModal()
    await act(async () => accountButton('home').click())
    await resolveStart(0)
    await resolveStart(1)

    expect(startCreationConfigurator).toHaveBeenLastCalledWith(6, PATTERN)
    await testState.ensureResources!([IMPORT_GRANT])
    expect(ensureAccountResources).toHaveBeenCalledExactlyOnceWith(6, [IMPORT_GRANT])
  })

  it('keeps the selection and the configurator when a grant arrives for the account', async () => {
    const { startCreationConfigurator, onChoose } = await renderModal()
    await resolveStart(0)
    expect(testState.mounts).toBe(1)

    await act(async () => testState.subscriber!.add(5,
      { uniqueName: 'work', grantedResourceUrlPatterns: [IMPORT_GRANT] } as AccountDescription,
      {} as VendorDescription, [], true, 'google'))

    expect(startCreationConfigurator).toHaveBeenCalledExactlyOnceWith(5, PATTERN)
    expect(starts[0].disposed).toBe(0)
    expect(testState.mounts).toBe(1)
    reportReady()
    await act(async () => approveButton().click())
    expect(onChoose).toHaveBeenCalledExactlyOnceWith({ accountId: 5, configuration: 'settings from frame-5' })
  })
})
