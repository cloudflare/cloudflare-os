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
// Answers only once the test lets it.
const SLOW = 10
const onDoc = { gatekeeperId: DOC, resourceTitle: 'Notes', resourceUrl: 'https://docs.example/notes' }
const read = (id: number, over = {}) => entry(id, { type: 'observation', state: 'approved', ...over })

const view = makeTestRoot()
afterEach(() => view.cleanup())

const mount = async () => {
  const server = makeOverseer()
  const described: WorkpieceId[] = []
  let answer = () => {}
  const slow = new Promise<void>(resolve => { answer = resolve })
  const overseer = Object.assign(server.overseer, {
    getGatekeeperById: (id: WorkpieceId) => ({
      describe: async () => {
        described.push(id)
        if (id === BUSY && described.length === 1) throw new Error('Google is busy')
        if (id === SLOW) await slow
        return { hasPreview: [DOC, BUSY, SLOW].includes(id) ? true : undefined }
      },
      getCreationSpec: async () => (
        { type: 'gatekeeper', vendorId: 'google', resourceUrl: 'https://docs.google.com/document/d/1/edit' }),
      [Symbol.dispose]: () => {},
    }),
  }) as RpcStub<Overseer>
  const offersPreview = previewOffers(async () => [])
  const opened: ConnectionPreview[] = []
  let dismiss: (preview: Pick<ConnectionPreview, 'gatekeeperId' | 'item'>) => void = () => {}
  const Probe = ({ workspace }: { workspace: string }) => {
    dismiss = useAutoOpenConnectionPreview(overseer, workspace, preview => opened.push(preview), offersPreview)
    return null
  }
  const enter = (workspace: string) => view.render(<Probe workspace={workspace} />)
  await enter('a')
  return { server, opened, described, enter, answer, dismiss: (gatekeeperId: WorkpieceId, item?: string) => dismiss({ gatekeeperId, item }) }
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

it('leaves closed a draft that is discarded while it is asked for its preview', async () => {
  const { server, opened, answer } = await mount()
  const draft = { gatekeeperId: SLOW, creation: true }

  await server.emit(entry(1, draft))
  await server.emit(entry(1, { ...draft, state: 'rejected' }))
  answer()
  await server.emit(entry(2))

  expect(opened).toEqual([])
})

it('opens an item of a connection when a change to it is queued, and keeps one that was dismissed closed', async () => {
  const { server, opened, described, dismiss } = await mount()
  const onFile = (id: string) => ({
    gatekeeperId: PLAIN,
    description: { title: 'Edit', description: '', previewOf: { id, title: `File ${id}`, url: `https://docs.example/${id}` } },
  })

  // A read names no item, and its connection offers no preview of itself.
  await server.emit(read(1, { gatekeeperId: PLAIN }))
  expect(opened).toEqual([])

  await server.emit(entry(2, onFile('a')))
  await server.emit(entry(3, onFile('b')))
  expect(opened).toEqual([
    { gatekeeperId: PLAIN, item: 'a', title: 'File a', url: 'https://docs.example/a' },
    { gatekeeperId: PLAIN, item: 'b', title: 'File b', url: 'https://docs.example/b' },
  ])

  dismiss(PLAIN, 'a')
  await server.emit(entry(4, onFile('a')))
  await server.emit(entry(5, onFile('b')))
  expect(opened.map(preview => preview.item)).toEqual(['a', 'b', 'b'])
  // The change itself is the offer: only the read asked the connection.
  expect(described).toEqual([PLAIN])
})

it('starts afresh in another workspace, where the same numbers name other things', async () => {
  const { server, opened, enter, dismiss } = await mount()
  await server.emit(entry(1, onDoc))
  dismiss(DOC)

  await enter('b')
  await server.emit(entry(1, onDoc))

  expect(opened).toHaveLength(2)
})
