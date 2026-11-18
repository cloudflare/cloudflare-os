// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { GatekeeperVendorInfo, Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entry, flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import type { ConnectionPreview, OffersPreview } from './connectionPreview'
import { previewOffers } from './connectionPreview'
import { usePendingConnectionPreviews } from './usePendingConnectionPreviews'

const DOC = 7
const PLAIN = 8

// The vendor names its types of resource; a connection says which of them it is.
const listVendors = async () => [{
  id: 'google',
  supportedResources: [
    { id: 'sheet', icon: { url: 'data:,sheet' } },
    { id: 'doc', icon: { url: 'data:,doc' } },
  ],
}] as unknown as GatekeeperVendorInfo[]

// A connection to a document that exists names it: one yet to be created names none.
const SPEC = { type: 'gatekeeper', vendorId: 'google', resourceTypeId: 'doc', resourceUrl: 'https://docs.google.com/document/d/1/edit' }

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('lists each connection with changes waiting that offers a preview, once', async () => {
  const server = makeOverseer()
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: (id: WorkpieceId) => ({
      describe: async () => ({ hasPreview: id === DOC ? true : undefined }),
      getCreationSpec: async () => SPEC,
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers(listVendors)
  let previews: ConnectionPreview[] = []
  const Probe = () => {
    previews = usePendingConnectionPreviews(overseer, offersPreview)
    return null
  }
  await view.render(<Probe />)
  await server.resolveSubscription()

  await server.resolvePendingQuery({
    entries: [
      entry(1, { gatekeeperId: DOC, resourceTitle: 'Notes' }),
      entry(2, { gatekeeperId: DOC, resourceTitle: 'Notes' }),
      entry(3, { gatekeeperId: PLAIN }),
      entry(4),
    ],
  })
  await act(async () => {})

  expect(previews).toEqual([{ gatekeeperId: DOC, title: 'Notes', url: undefined, iconUrl: 'data:,doc' }])
})

it('links to the document as it is once it is created, though changes queued before then still wait', async () => {
  const server = makeOverseer()
  const home = 'https://docs.google.com/document/'
  const made = 'https://docs.google.com/document/d/made/edit'
  let url = home
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: () => ({
      describe: async () => ({ hasPreview: true, url }),
      getCreationSpec: async () => ({ ...SPEC, resourceUrl: url === home ? undefined : url }),
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers(listVendors)
  let previews: ConnectionPreview[] = []
  const Probe = () => {
    previews = usePendingConnectionPreviews(overseer, offersPreview)
    return null
  }
  await view.render(<Probe />)
  await server.resolveSubscription()
  // The draft's creation, and an edit queued on it: both recorded before any document was.
  const drafted = { gatekeeperId: DOC, resourceTitle: 'Notes', resourceUrl: home }
  await server.resolvePendingQuery({ entries: [entry(1, { ...drafted, creation: true }), entry(2, drafted)] })
  await act(async () => {})
  expect(previews).toMatchObject([{ gatekeeperId: DOC, url: home }])

  // Approval records the document on the creation alone: the edit keeps what it was queued with.
  url = made
  await server.emit(entry(1, { ...drafted, creation: true, state: 'approved', resourceUrl: made }))
  await act(async () => flushFrames())
  await act(async () => {})

  expect(previews).toEqual([{ gatekeeperId: DOC, title: 'Notes', url: made, iconUrl: 'data:,doc' }])
})

it('asks a connection again after a lookup that failed, and no more once it has answered', async () => {
  let asked = 0
  const overseer = {
    getGatekeeperById: () => ({
      describe: async () => {
        if (++asked === 1) throw new Error('Google is busy')
        return { hasPreview: true }
      },
      // A connection whose type cannot be told is drawn without an icon.
      getCreationSpec: async () => { throw new Error('Not a gatekeeper') },
      [Symbol.dispose]: () => {},
    }),
  } as unknown as RpcStub<Overseer>
  const offersPreview = previewOffers(listVendors)

  await expect(offersPreview(overseer, { gatekeeperId: DOC })).rejects.toThrow('Google is busy')
  expect(await offersPreview(overseer, { gatekeeperId: DOC })).toEqual({ iconUrl: undefined })
  await offersPreview(overseer, { gatekeeperId: DOC })
  expect(asked).toBe(2)
})

it('lists a connection that could not be asked once it can be, and nothing another workspace was offered', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const server = makeOverseer()
  let asked = 0
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: () => ({
      describe: async () => {
        if (++asked === 1) throw new Error('Google is busy')
        return { hasPreview: true }
      },
      getCreationSpec: async () => SPEC,
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  let previews: ConnectionPreview[] = []
  const Probe = ({ offersPreview }: { offersPreview: OffersPreview }) => {
    previews = usePendingConnectionPreviews(overseer, offersPreview)
    return null
  }
  const here = previewOffers(listVendors)
  await view.render(<Probe offersPreview={here} />)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [entry(1, { gatekeeperId: DOC, resourceTitle: 'Notes' })] })
  await act(async () => {})
  expect(previews).toEqual([])

  await act(() => vi.advanceTimersByTimeAsync(2_000))
  expect(previews).toHaveLength(1)

  // In another workspace the same number is another connection, which has not answered yet.
  await view.render(<Probe offersPreview={() => new Promise(() => {})} />)
  expect(previews).toEqual([])
  vi.useRealTimers()
})

it('asks again as soon as at first once every connection has answered', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const server = makeOverseer()
  let asked = 0
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: () => ({
      // Each connection fails the first time it is asked.
      describe: async () => {
        if (++asked % 2) throw new Error('Google is busy')
        return { hasPreview: true }
      },
      getCreationSpec: async () => SPEC,
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers(listVendors)
  let previews: ConnectionPreview[] = []
  const Probe = () => {
    previews = usePendingConnectionPreviews(overseer, offersPreview)
    return null
  }
  await view.render(<Probe />)
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [entry(1, { gatekeeperId: DOC, resourceTitle: 'Notes' })] })
  await act(async () => {})
  await act(() => vi.advanceTimersByTimeAsync(2_000))
  expect(previews).toHaveLength(1)

  await server.emit(entry(2, { gatekeeperId: PLAIN, resourceTitle: 'Plan' }))
  await act(async () => flushFrames())
  expect(previews).toHaveLength(1)
  await act(() => vi.advanceTimersByTimeAsync(2_000))
  expect(previews).toHaveLength(2)
  vi.useRealTimers()
})
