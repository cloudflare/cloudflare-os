/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { GatekeeperUiFrame, GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'
import SandboxedGatekeeperApp from './SandboxedGatekeeperApp'
import './styles.css'

const context = vi.hoisted(() => ({ navigate: vi.fn<() => void>(), authenticatedApi: {} }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => context.navigate }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: context.authenticatedApi }) }))
vi.mock('./ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }))
vi.mock('./ServerConfigContext', () => ({ useServerConfig: () => ({ userSearchEnabled: false }) }))
vi.mock('./errorReporting', () => ({ forwardTrustedFrameError: () => false }))

interface Host extends RpcTarget {
  downloadFile(url: string): Promise<void>
  selectUsers(receiver: GatekeeperUserSelectionReceiver): Promise<void>
}
class Receiver extends RpcTarget implements GatekeeperUserSelectionReceiver {
  async receive(): Promise<void> {}
}
class EmptyUi extends RpcTarget {}
let root: Root | undefined
let container: HTMLElement | undefined
let host: RpcStub<Host> | undefined
let ui: RpcStub<EmptyUi> | undefined
afterEach(async () => {
  host?.[Symbol.dispose]()
  await act(async () => root?.unmount())
  ui?.[Symbol.dispose]()
  container?.remove()
  vi.restoreAllMocks()
})

it('keeps download confirmation and person selection exclusive with the real dialogs', async () => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  ui = new RpcStub(new EmptyUi())
  const frame = { iframeHtml: '<!doctype html><title>Service</title>', ui } as unknown as GatekeeperUiFrame
  await act(async () => root!.render(<SandboxedGatekeeperApp frame={frame} gatekeeperVendorId="context" path="/" />))
  const iframe = container.querySelector('iframe')!
  const { port1, port2 } = new MessageChannel()
  host = newMessagePortRpcSession<Host>(port1)
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'handshake' }, origin: 'null', source: iframe.contentWindow, ports: [port2],
  }))
  const fetch = vi.spyOn(globalThis, 'fetch')
  const url = `${window.location.origin}/gatekeeper/context/exports/fixture`
  const picker = host.selectUsers(new Receiver())
  await expect.element(page.getByRole('dialog', { name: 'Select users' })).toBeVisible()
  await expect(host.downloadFile(url)).rejects.toThrow('Another gatekeeper prompt is already open.')
  // A strict role lookup also fails if a covered second modal remains in the accessibility tree.
  expect(page.getByRole('dialog').element()).toBe(page.getByRole('dialog', { name: 'Select users' }).element())
  await userEvent.click(page.getByRole('button', { name: 'Done', exact: true }))
  await picker

  const download = host.downloadFile(url)
  void download.catch(() => {})
  await expect.element(page.getByRole('dialog', { name: 'Download file?' })).toBeVisible()
  await expect(host.selectUsers(new Receiver())).rejects.toThrow('Another gatekeeper prompt is already open.')
  expect(page.getByRole('dialog').element()).toBe(page.getByRole('dialog', { name: 'Download file?' }).element())
  await userEvent.click(page.getByRole('button', { name: 'Cancel', exact: true }))
  await expect(download).rejects.toThrow('Download cancelled.')

  const reopened = host.selectUsers(new Receiver())
  await expect.element(page.getByRole('dialog', { name: 'Select users' })).toBeVisible()
  await userEvent.click(page.getByRole('button', { name: 'Done', exact: true }))
  await reopened
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  expect(fetch).not.toHaveBeenCalled()
})
