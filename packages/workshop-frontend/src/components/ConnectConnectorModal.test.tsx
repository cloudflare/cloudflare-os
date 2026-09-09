// @vitest-environment jsdom

import React, { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@cloudflare/kumo', () => {
  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => React.createElement('div', null, children),
    {
      Root: ({ children }: { children: ReactNode }) => <>{children}</>,
      Title: ({ children }: { children: ReactNode }) => <h1>{children}</h1>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: ComponentProps<'button'>) => ReactNode }) => render({ type: 'button' }),
    },
  )
  return {
    Dialog,
    Switch: ({ 'aria-label': label }: { 'aria-label'?: string }) => (
      <input type="checkbox" aria-label={label} readOnly />
    ),
  }
})

vi.mock('./WorkshopControls', () => ({
  WorkshopButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

import ConnectConnectorModal from './ConnectConnectorModal'

const JIRA_VENDOR: VendorDescription = {
  displayName: 'Jira',
  url: 'https://www.atlassian.com/software/jira',
}
const JIRA_SITE: SupportedResource = {
  title: 'Jira site',
  description: 'Pick an authorized Jira site.',
  urlPattern: 'https://:site.atlassian.net/*',
  grantable: true,
}
const ACCOUNT: AccountDescription = {
  displayName: 'Jacob Jira',
  uniqueName: 'acme.atlassian.net',
  avatar: { url: 'https://acme.atlassian.net/avatar.png' },
  grantedResourceUrlPatterns: [JIRA_SITE.urlPattern],
}

describe('ConnectConnectorModal manage-mode reconnect', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = undefined
    container = undefined
    vi.clearAllMocks()
  })

  async function renderManage(
    props: Partial<ComponentProps<typeof ConnectConnectorModal>> = {},
  ) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ConnectConnectorModal
          open
          mode="manage"
          vendorDescription={JIRA_VENDOR}
          supportedResources={[JIRA_SITE]}
          accountDescription={ACCOUNT}
          grantedResourceUrlPatterns={[JIRA_SITE.urlPattern]}
          onOpenChange={() => {}}
          onDisconnect={() => {}}
          {...props}
        />,
      )
    })
  }

  const buttons = () => [...container!.querySelectorAll('button')]
  const button = (label: string) =>
    buttons().find((b) => b.textContent?.trim() === label)

  it('omits the reconnect action when the caller does not opt in', async () => {
    await renderManage()

    expect(button('Close')).toBeDefined()
    expect(button('Disconnect')).toBeDefined()
    expect(button('Reconnect')).toBeUndefined()
  })

  it('invokes onReconnect for a healthy connection without disconnecting it', async () => {
    const onReconnect = vi.fn<() => void>()
    const onDisconnect = vi.fn<() => void>()
    await renderManage({ onReconnect, onDisconnect, credentialsValid: true })

    const reconnect = button('Reconnect')
    expect(reconnect).toBeDefined()
    expect(reconnect!.disabled).toBe(false)

    await act(async () => { reconnect!.click() })

    expect(onReconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).not.toHaveBeenCalled()
    // Reconnecting must not shortcut into the destructive confirmation.
    expect(button('Yes, disconnect')).toBeUndefined()
  })

  it('disables the conflicting actions while the reconnect flow is opening', async () => {
    const onReconnect = vi.fn<() => void>()
    await renderManage({ onReconnect, reconnecting: true })

    expect(button('Reconnect')).toBeUndefined()
    const opening = button('Opening...')
    expect(opening).toBeDefined()
    expect(opening!.disabled).toBe(true)
    expect(button('Disconnect')!.disabled).toBe(true)
    expect(button('Close')!.disabled).toBe(true)
  })

  it('disables reconnect while a disconnect is in flight', async () => {
    await renderManage({ onReconnect: vi.fn<() => void>(), disconnecting: true })

    expect(button('Reconnect')!.disabled).toBe(true)
  })

  it('keeps connect mode free of manage actions', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => {
      root!.render(
        <ConnectConnectorModal
          open
          mode="connect"
          vendorDescription={JIRA_VENDOR}
          supportedResources={[JIRA_SITE]}
          onOpenChange={() => {}}
          onConfirm={() => {}}
          onReconnect={vi.fn<() => void>()}
        />,
      )
    })

    expect(button('Reconnect')).toBeUndefined()
    expect(button('Disconnect')).toBeUndefined()
    expect(button('Continue to Jira')).toBeDefined()
  })
})
