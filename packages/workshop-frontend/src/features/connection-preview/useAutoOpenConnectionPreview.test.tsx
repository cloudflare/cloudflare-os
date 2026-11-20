// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer, WorkpieceId } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import type { ConnectionPreview } from './connectionPreview'
import { previewOffers } from './connectionPreview'
import { useAutoOpenConnectionPreview } from './useAutoOpenConnectionPreview'

const DOC = 7
const PLAIN = 8
// Cannot be asked the first time.
const BUSY = 9
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
        if (id === BUSY && described.length === 1) throw new Error('Google is busy')
        return { hasPreview: id === DOC || id === BUSY ? true : undefined }
      },
      getCreationSpec: async () => (
        { type: 'gatekeeper', vendorId: 'google', resourceUrl: 'https://docs.google.com/document/d/1/edit' }),
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers(async () => [])
  const opened: ConnectionPreview[] = []
  let dismiss: (gatekeeperId: WorkpieceId) => void = () => {}
  const Probe = ({ workspace }: { workspace: string }) => {
    dismiss = useAutoOpenConnectionPreview(overseer, workspace, preview => opened.push(preview), offersPreview)
    return null
  }
  const enter = (workspace: string) => view.render(<Probe workspace={workspace} />)
  await enter('a')
  return { server, opened, described, enter, dismiss: (id: WorkpieceId) => dismiss(id) }
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

it('asks a connection that could not be asked again at its next read', async () => {
  const { server, opened } = await mount()

  await server.emit(read(1, { gatekeeperId: BUSY }))
  expect(opened).toEqual([])

  await server.emit(read(2, { gatekeeperId: BUSY }))
  expect(opened).toHaveLength(1)
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

it('starts afresh in another workspace, where the same numbers name other things', async () => {
  const { server, opened, enter, dismiss } = await mount()
  await server.emit(entry(1, onDoc))
  dismiss(DOC)

  await enter('b')
  await server.emit(entry(1, onDoc))

  expect(opened).toHaveLength(2)
})
