// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import type { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'

type HostProps = {
  frame: ResourceConfiguratorFrame
  hidden?: boolean
  initialResourceUrl?: string
  resourceUrlPattern?: string
  onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
  onSelectionReadyChange?: (ready: boolean | null) => void
}

const testState = vi.hoisted(() => ({ hostProps: null as HostProps | null }))

vi.mock('./ResourceConfiguratorHost', () => {
  const ResourceConfiguratorHost = (props: HostProps) => {
    testState.hostProps = props
    return null
  }
  return { default: ResourceConfiguratorHost }
})

import BlueprintSuggestedResourceResolver from './BlueprintSuggestedResourceResolver'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RESOURCE_URL_PATTERN = 'https://calendar.google.com/calendar/:calendarId/*'
const SUGGESTED_RESOURCE_URL =
  'https://calendar.google.com/calendar/creator%40example.com/?availability=thisCalendar'

const configuratorFrame = (dispose: () => void): ResourceConfiguratorFrame => ({
  iframeHtml: '<!doctype html>',
  ui: { [Symbol.dispose]: dispose } as ResourceConfiguratorFrame['ui'],
})

const authenticatedApi = (
  startResourceConfigurator: (accountId: number, resourceUrlPattern: string) =>
    Promise<ResourceConfiguratorFrame>,
) => ({ startResourceConfigurator }) as unknown as RpcStub<AuthenticatedApi>

describe('BlueprintSuggestedResourceResolver', () => {
  let root: Root | undefined
  let rootContainer: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    rootContainer?.remove()
    rootContainer = undefined
    testState.hostProps = null
  })

  const renderResolver = async (
    startResourceConfigurator: (accountId: number, resourceUrlPattern: string) =>
      Promise<ResourceConfiguratorFrame>,
    onResolved = vi.fn<(resourceUrl: string) => void>(),
    onRejected = vi.fn<() => void>(),
  ) => {
    rootContainer = document.createElement('div')
    document.body.appendChild(rootContainer)
    root = createRoot(rootContainer)
    await act(async () => root!.render(
      <BlueprintSuggestedResourceResolver
        accountId={7}
        resourceUrl={SUGGESTED_RESOURCE_URL}
        resourceUrlPattern={RESOURCE_URL_PATTERN}
        authenticatedApi={authenticatedApi(startResourceConfigurator)}
        onResolved={onResolved}
        onRejected={onRejected}
      />,
    ))
    return { onResolved, onRejected }
  }

  it('collects and normalizes a suggestion after the configurator accepts it', async () => {
    const dispose = vi.fn<() => void>()
    const startResourceConfigurator = vi.fn<
      (accountId: number, resourceUrlPattern: string) => Promise<ResourceConfiguratorFrame>
    >().mockResolvedValue(configuratorFrame(dispose))
    const { onResolved, onRejected } = await renderResolver(startResourceConfigurator)
    await vi.waitFor(() => expect(testState.hostProps).not.toBeNull())

    const collectedUrl =
      'https://calendar.google.com/calendar/recipient%40example.com/*'
    await act(async () => {
      testState.hostProps!.onCollectResourceUrlChange?.(() => Promise.resolve(collectedUrl))
      testState.hostProps!.onSelectionReadyChange?.(true)
      await Promise.resolve()
    })

    expect(startResourceConfigurator).toHaveBeenCalledExactlyOnceWith(7, RESOURCE_URL_PATTERN)
    expect(testState.hostProps).toMatchObject({
      hidden: true,
      initialResourceUrl: SUGGESTED_RESOURCE_URL,
      resourceUrlPattern: RESOURCE_URL_PATTERN,
    })
    expect(onResolved).toHaveBeenCalledExactlyOnceWith(
      'https://calendar.google.com/calendar/recipient%40example.com',
    )
    expect(onRejected).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects and disposes a suggestion the configurator cannot accept', async () => {
    const dispose = vi.fn<() => void>()
    const startResourceConfigurator = vi.fn<
      (accountId: number, resourceUrlPattern: string) => Promise<ResourceConfiguratorFrame>
    >().mockResolvedValue(configuratorFrame(dispose))
    const { onResolved, onRejected } = await renderResolver(startResourceConfigurator)
    await vi.waitFor(() => expect(testState.hostProps).not.toBeNull())

    act(() => testState.hostProps!.onSelectionReadyChange?.(false))

    expect(onResolved).not.toHaveBeenCalled()
    expect(onRejected).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a configurator that arrives after unmount', async () => {
    const dispose = vi.fn<() => void>()
    let resolveFrame: ((frame: ResourceConfiguratorFrame) => void) | undefined
    const startResourceConfigurator = vi.fn<
      (accountId: number, resourceUrlPattern: string) => Promise<ResourceConfiguratorFrame>
    >().mockReturnValue(new Promise(resolve => { resolveFrame = resolve }))
    const { onResolved, onRejected } = await renderResolver(startResourceConfigurator)

    act(() => root!.unmount())
    root = undefined
    await act(async () => {
      resolveFrame!(configuratorFrame(dispose))
      await Promise.resolve()
    })

    expect(onResolved).not.toHaveBeenCalled()
    expect(onRejected).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })
})
