// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import type { ConnectionPreview } from './connectionPreview'
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
  let previews: ConnectionPreview[] = []
  const Probe = () => {
    previews = usePendingConnectionPreviews(overseer)
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
