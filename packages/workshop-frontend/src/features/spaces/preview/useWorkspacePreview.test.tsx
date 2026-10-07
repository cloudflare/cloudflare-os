// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type GadgetMetadata,
  type ObserverBindingNeed,
  type ObserverConfigCallback,
} from '@gadgets/workshop-shared/api'
import { deferred, fakeApi, mount, settle, unmountAll } from '../spacesTestUtils'
import { useWorkspacePreview, type WorkspacePreviewState } from './useWorkspacePreview'

const metadata = (id: string, title: string): GadgetMetadata => ({ id, title, role: 'use' })

const NEED: ObserverBindingNeed = { gatekeeperId: 4, vendorId: 'google', resourceTitle: 'Calendar' }

type Opened = {
  id: string
  shareKey: string | undefined
  configureObservers: RpcStub<ObserverConfigCallback>
  overseer: ReturnType<typeof fakeOverseer>
}

// An open workspace whose metadata subscription is answered by `subscribe`, and which records
// what was disposed.
const fakeOverseer = (subscribe: (
  callback: (metadata: GadgetMetadata) => void,
  configureObservers: RpcStub<ObserverConfigCallback>,
) => Promise<Disposable>) => {
  const dispose = vi.fn<() => void>()
  const unsubscribe = vi.fn<() => void>()
  return { dispose, unsubscribe, subscribe }
}

// An api whose `openGadget` hands out an overseer made by `makeOverseer` for each open.
const openingApi = (makeOverseer: (id: string) => ReturnType<typeof fakeOverseer>) => {
  const opened: Opened[] = []
  type OpenGadget = (id: string, shareKey: string | undefined, configureObservers: RpcStub<ObserverConfigCallback>) => unknown
  const openGadget = vi.fn<OpenGadget>((id, shareKey, configureObservers) => {
    const overseer = makeOverseer(id)
    opened.push({ id, shareKey, configureObservers, overseer })
    return {
      subscribeToMetadata: (callback: (metadata: GadgetMetadata) => void) =>
        overseer.subscribe(callback, configureObservers),
      [Symbol.dispose]: overseer.dispose,
    }
  })
  return { api: fakeApi({ openGadget }), openGadget, opened }
}

// Answers at once with the workspace's metadata, as an open the viewer may make does.
const answering = (id: string) => {
  const overseer = fakeOverseer(async (callback) => {
    callback(metadata(id, `Workspace ${id}`))
    return { [Symbol.dispose]: overseer.unsubscribe }
  })
  return overseer
}

let latest: (WorkspacePreviewState & { retry: () => void }) | undefined

const Probe = ({ workspaceId }: { workspaceId: string }) => {
  latest = useWorkspacePreview(workspaceId)
  return null
}

describe('useWorkspacePreview', () => {
  afterEach(() => {
    unmountAll()
    latest = undefined
    document.title = ''
    vi.restoreAllMocks()
  })

  it('opens the workspace without a share key and reports it with its metadata, leaving the tab’s title alone', async () => {
    document.title = 'Workspaces'
    const { api, opened } = openingApi(answering)
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    expect(opened).toHaveLength(1)
    expect(opened[0].id).toBe('w1')
    expect(opened[0].shareKey).toBeUndefined()
    expect(latest?.state).toBe('ready')
    expect(latest?.state === 'ready' && latest.metadata.title).toBe('Workspace w1')
    expect(document.title).toBe('Workspaces')
  })

  it('reports loading until the metadata arrives', async () => {
    const pending = deferred<Disposable>()
    const { api } = openingApi(() => fakeOverseer(() => pending.promise))
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    expect(latest?.state).toBe('loading')
  })

  it('follows later changes to the metadata', async () => {
    let push!: (metadata: GadgetMetadata) => void
    const { api } = openingApi(() => {
      const overseer = fakeOverseer(async (callback) => {
        push = callback
        callback(metadata('w1', 'Before'))
        return { [Symbol.dispose]: overseer.unsubscribe }
      })
      return overseer
    })
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    await act(async () => push(metadata('w1', 'After')))
    expect(latest?.state === 'ready' && latest.metadata.title).toBe('After')
  })

  it('lets go of one workspace when it is given another, and of everything when it unmounts', async () => {
    const { api, opened } = openingApi(answering)
    const { rerender, unmount } = await mount(<Probe workspaceId="w1" />, api)
    await settle()

    await rerender(<Probe workspaceId="w2" />)
    await settle()
    const [first, second] = opened
    expect(first.overseer.unsubscribe).toHaveBeenCalledTimes(1)
    expect(first.overseer.dispose).toHaveBeenCalledTimes(1)
    expect(second.id).toBe('w2')
    expect(second.overseer.dispose).not.toHaveBeenCalled()
    expect(latest?.state === 'ready' && latest.metadata.id).toBe('w2')

    await unmount()
    expect(second.overseer.unsubscribe).toHaveBeenCalledTimes(1)
    expect(second.overseer.dispose).toHaveBeenCalledTimes(1)
    // The callback offered to the workspace goes with it.
    await expect(Promise.resolve().then(() => second.configureObservers.configure([NEED])))
      .rejects.toThrow(/dispos/i)
  })

  it('never reports the previous workspace as the one now asked for', async () => {
    const second = deferred<Disposable>()
    const { api } = openingApi(id => (id === 'w1' ? answering(id) : fakeOverseer(() => second.promise)))
    const { rerender } = await mount(<Probe workspaceId="w1" />, api)
    await settle()
    expect(latest?.state).toBe('ready')

    await rerender(<Probe workspaceId="w2" />)
    expect(latest?.state).toBe('loading')
  })

  it('disposes a subscription that arrives after the workspace was let go', async () => {
    const pending = deferred<Disposable>()
    const unsubscribe = vi.fn<() => void>()
    const { api, opened } = openingApi(() => fakeOverseer(() => pending.promise))
    const { unmount } = await mount(<Probe workspaceId="w1" />, api)
    await unmount()

    await act(async () => { pending.resolve({ [Symbol.dispose]: unsubscribe }) })
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(opened[0].overseer.dispose).toHaveBeenCalledTimes(1)
  })

  it('declines to choose connected accounts, and reports that the workspace needs setting up', async () => {
    let choice: Promise<unknown> | undefined
    const { api } = openingApi(() => fakeOverseer(async (_callback, configureObservers) => {
      // The workspace asks the viewer for accounts, and denies the open when they decline.
      choice = Promise.resolve(configureObservers.configure([NEED])).catch((err: unknown) => err)
      await choice
      throw new Error('To open this workspace you must connect an account for every service it uses.')
    }))
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    expect(await choice).toBeInstanceOf(Error)
    expect(latest).toMatchObject({ state: 'failed', failure: 'needs-setup' })
  })

  it.each([
    [OPEN_GADGET_ERROR_CODES.workspaceNotVisible, 'not-visible'],
    [OPEN_GADGET_ERROR_CODES.workspaceAccessDenied, 'access-denied'],
    [OPEN_GADGET_ERROR_CODES.workspaceNotFound, 'not-found'],
  ] as const)('reports an open refused with %s as %s', async (code, failure) => {
    const { api } = openingApi(() => fakeOverseer(async () => { throw createOpenGadgetError(code) }))
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    expect(latest).toMatchObject({ state: 'failed', failure })
  })

  it('lets go of a failed open at once, and only once', async () => {
    const { api, opened } = openingApi(() => fakeOverseer(async () => {
      throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
    }))
    await mount(<Probe workspaceId="w1" />, api)
    await settle()

    expect(latest).toMatchObject({ state: 'failed', failure: 'access-denied' })
    expect(opened[0].overseer.dispose).toHaveBeenCalledTimes(1)
    await expect(Promise.resolve().then(() => opened[0].configureObservers.configure([NEED])))
      .rejects.toThrow('after it has been disposed')

    unmountAll()
    expect(opened[0].overseer.dispose).toHaveBeenCalledTimes(1)
  })

  it('opens the workspace again on retry, letting go of the failed open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    const { api, opened } = openingApi((id) => {
      if (!fail) return answering(id)
      return fakeOverseer(async () => { throw new Error('Network trouble') })
    })
    await mount(<Probe workspaceId="w1" />, api)
    await settle()
    expect(latest).toMatchObject({ state: 'failed', failure: 'unexpected' })

    fail = false
    await act(async () => latest!.retry())
    await settle()
    expect(opened).toHaveLength(2)
    expect(opened[0].overseer.dispose).toHaveBeenCalledTimes(1)
    expect(latest?.state).toBe('ready')
  })
})
