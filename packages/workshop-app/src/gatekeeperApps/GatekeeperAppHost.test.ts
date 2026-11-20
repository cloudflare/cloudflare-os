import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GatekeeperUserSelectionReceiver } from '@gadgets/workshop-shared/gatekeeper'
import type { GatekeeperAppTheme, GatekeeperAppThemeReceiver } from '@gadgets/workshop-shared/theme'
import { GatekeeperAppHost, type AppHostPage } from './GatekeeperAppHost'

const LIGHT: GatekeeperAppTheme = { mode: 'light', accentColor: null }
const DARK: GatekeeperAppTheme = { mode: 'dark', accentColor: '#ff6600' }
const WORKSPACE_ID = 'a'.repeat(64)

// A stub as the frame passes one: what it was called with, and whether its copy was let go of.
const stubOf = <T extends object>(methods: T) => {
  const copy = { ...methods, disposed: false, [Symbol.dispose]() { copy.disposed = true } }
  const stub = { ...methods, dup: () => copy, [Symbol.dispose]() {} }
  return { stub, copy }
}

const pageOf = (overrides: Partial<AppHostPage> = {}) => ({
  present: vi.fn<AppHostPage['present']>(() => ({ rect: { left: 1, top: 2, width: 3, height: 4 }, willResize: true })),
  openWorkspace: vi.fn<AppHostPage['openWorkspace']>(),
  openPrompt: vi.fn<AppHostPage['openPrompt']>(),
  resolveWorkspaceTitles: vi.fn<AppHostPage['resolveWorkspaceTitles']>(async (ids) => ids.map(() => 'Title')),
  openUserPicker: vi.fn<AppHostPage['openUserPicker']>(async () => {}),
  cancelUserPicker: vi.fn<AppHostPage['cancelUserPicker']>(),
  ...overrides,
})

describe('GatekeeperAppHost', () => {
  let frames: (() => void)[]
  beforeEach(() => {
    frames = []
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback))
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      frames[id - 1] = () => {}
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  const nextFrame = () => {
    const due = frames
    frames = []
    for (const callback of due) callback()
  }

  it('relays its gatekeeper’s API to the app', async () => {
    const host = new GatekeeperAppHost({ ping: async (value: string) => `pong ${value}` }, pageOf(), LIGHT)
    // The gatekeeper's API is its own, which the host knows nothing of.
    const ui: { ping: (value: string) => Promise<string> } = host.ui as never
    await expect(ui.ping('there')).resolves.toBe('pong there')
  })

  it('gives the theme, and each change to it, to the app that asked, until it goes', () => {
    const host = new GatekeeperAppHost({}, pageOf(), LIGHT)
    const setTheme = vi.fn<(theme: GatekeeperAppTheme) => void>()
    const { stub, copy } = stubOf({ setTheme })
    expect(host.subscribeTheme(stub as unknown as RpcStub<GatekeeperAppThemeReceiver>)).toEqual(LIGHT)
    host.updateTheme(DARK)
    expect(setTheme).toHaveBeenCalledWith(DARK)
    host.dispose()
    expect(copy.disposed).toBe(true)
  })

  it('checks where the app asks to go, and what it asks to start a chat with', () => {
    const page = pageOf()
    const host = new GatekeeperAppHost({}, page, LIGHT)
    host.openWorkspace(WORKSPACE_ID, 7)
    expect(page.openWorkspace).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID, gadgetId: 7 })
    expect(() => host.openWorkspace('../admin')).toThrow('Invalid gatekeeper app workspace target')
    host.openPrompt('  Summarise my week  ')
    expect(page.openPrompt).toHaveBeenCalledWith('Summarise my week')
    expect(() => host.openPrompt('  ')).toThrow('cannot be empty')
  })

  it('looks up no more workspaces at once than a page of the app’s', async () => {
    const page = pageOf()
    const host = new GatekeeperAppHost({}, page, LIGHT)
    await expect(host.resolveWorkspaceTitles([WORKSPACE_ID])).resolves.toEqual(['Title'])
    await expect(host.resolveWorkspaceTitles(Array.from({ length: 101 }, () => WORKSPACE_ID))).rejects.toThrow('Invalid workspace title lookup')
    await expect(host.resolveWorkspaceTitles('x' as unknown as string[])).rejects.toThrow('Invalid workspace title lookup')
    expect(page.resolveWorkspaceTitles).toHaveBeenCalledTimes(1)
  })

  it('gives the picker its own copy of the receiver, and lets go of it where it cannot open', async () => {
    const page = pageOf()
    const host = new GatekeeperAppHost({}, page, LIGHT)
    const opened = stubOf({ receive: async () => {} })
    await host.selectUsers(opened.stub as unknown as RpcStub<GatekeeperUserSelectionReceiver>)
    expect(page.openUserPicker).toHaveBeenCalledWith(opened.copy)
    expect(opened.copy.disposed).toBe(false)

    const busy = new GatekeeperAppHost({}, pageOf({ openUserPicker: () => { throw new Error('A person picker is already open.') } }), LIGHT)
    const refused = stubOf({ receive: async () => {} })
    await expect(busy.selectUsers(refused.stub as unknown as RpcStub<GatekeeperUserSelectionReceiver>)).rejects.toThrow('already open')
    expect(refused.copy.disposed).toBe(true)
    await expect(busy.selectUsers({} as RpcStub<GatekeeperUserSelectionReceiver>)).rejects.toThrow('requires a receiver capability')
  })

  it('grows over the window once a frame, as last asked, and is put back when the app goes', async () => {
    const page = pageOf()
    const host = new GatekeeperAppHost({}, page, LIGHT)
    const first = host.setPresenting(true)
    const second = host.setPresenting(true)
    nextFrame()
    await expect(first).resolves.toEqual({ rect: { left: 1, top: 2, width: 3, height: 4 }, willResize: true })
    await expect(second).resolves.toEqual({ rect: { left: 1, top: 2, width: 3, height: 4 }, willResize: true })
    expect(page.present).toHaveBeenCalledTimes(1)

    // Asked for again as it is, nothing is done.
    const again = host.setPresenting(true)
    nextFrame()
    await expect(again).resolves.toEqual({ rect: null, willResize: false })

    const pending = host.setPresenting(false)
    host.dispose()
    await expect(pending).resolves.toEqual({ rect: null, willResize: false })
    expect(page.present).toHaveBeenLastCalledWith(false)
    expect(page.cancelUserPicker).toHaveBeenCalled()
  })
})
