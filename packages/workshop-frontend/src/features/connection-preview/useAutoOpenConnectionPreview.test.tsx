// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import type { ConnectionPreview } from './connectionPreview'
import { useAutoOpenConnectionPreview } from './useAutoOpenConnectionPreview'

const DOC = 7
const PLAIN = 8
const onDoc = { gatekeeperId: DOC, resourceTitle: 'Notes', resourceUrl: 'https://docs.example/notes' }
const read = (id: number, over = {}) => entry(id, { type: 'observation', state: 'approved', ...over })

const view = makeTestRoot()
afterEach(() => view.cleanup())

const mount = async () => {
  const server = makeOverseer()
  const described: WorkpieceId[] = []
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: (id: WorkpieceId) => ({
      describe: async () => {
        described.push(id)
        return { hasPreview: id === DOC ? true : undefined }
      },
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const opened: ConnectionPreview[] = []
  let dismiss: (gatekeeperId: WorkpieceId) => void = () => {}
  const Probe = () => {
    dismiss = useAutoOpenConnectionPreview(overseer, preview => opened.push(preview))
    return null
  }
  await view.render(<Probe />)
  return { server, opened, described, dismiss: (id: WorkpieceId) => dismiss(id) }
}

it('opens a connection at its first read and at each change queued after', async () => {
  const { server, opened, described } = await mount()

  await server.emit(read(1, onDoc))
  expect(opened).toEqual([{ gatekeeperId: DOC, title: 'Notes', url: 'https://docs.example/notes' }])

  // The preview's own reads land on its connection, and must not reopen it.
  await server.emit(read(2, onDoc))
  expect(opened).toHaveLength(1)

  await server.emit(entry(3, onDoc))
  expect(opened).toHaveLength(2)

  // The same change again, now resolved, is not new work.
  await server.emit(entry(3, { ...onDoc, state: 'approved' }))
  expect(opened).toHaveLength(2)
  expect(described).toEqual([DOC])
})

it('leaves a connection with no preview alone', async () => {
  const { server, opened } = await mount()

  await server.emit(entry(1, { gatekeeperId: PLAIN }))
  await server.emit(entry(2))

  expect(opened).toEqual([])
})

it('keeps a dismissed connection closed', async () => {
  const { server, opened, dismiss } = await mount()
  await server.emit(entry(1, onDoc))
  expect(opened).toHaveLength(1)

  dismiss(DOC)
  await server.emit(entry(2, onDoc))

  expect(opened).toHaveLength(1)
})
