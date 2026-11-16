// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import type { ConnectionPreview, OffersPreview } from './connectionPreview'
import { previewOffers } from './connectionPreview'
import { usePendingConnectionPreviews } from './usePendingConnectionPreviews'

const DOC = 7
const PLAIN = 8

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('lists each connection with changes waiting that offers a preview, once', async () => {
  const server = makeOverseer()
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: (id: WorkpieceId) => ({
      describe: async () => ({ hasPreview: id === DOC ? true : undefined }),
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers()
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

  expect(previews).toEqual([{ gatekeeperId: DOC, title: 'Notes', url: undefined }])
})

it('asks a connection again after a lookup that failed, and no more once it has answered', async () => {
  let asked = 0
  const overseer = {
    getGatekeeperById: () => ({
      describe: async () => {
        if (++asked === 1) throw new Error('Google is busy')
        return { hasPreview: true }
      },
      [Symbol.dispose]: () => {},
    }),
  } as unknown as RpcStub<Overseer>
  const offersPreview = previewOffers()

  await expect(offersPreview(overseer, DOC)).rejects.toThrow('Google is busy')
  expect(await offersPreview(overseer, DOC)).toBe(true)
  await offersPreview(overseer, DOC)
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
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  let previews: ConnectionPreview[] = []
  const Probe = ({ offersPreview }: { offersPreview: OffersPreview }) => {
    previews = usePendingConnectionPreviews(overseer, offersPreview)
    return null
  }
  const here = previewOffers()
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
