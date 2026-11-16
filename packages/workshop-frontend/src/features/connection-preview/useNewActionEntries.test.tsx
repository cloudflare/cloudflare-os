// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, expect, it } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { linkActionLog, useActionEntries } from '../../useActions'
import { useNewActionEntries } from './useNewActionEntries'

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('leaves out what a workspace entered later had already received', async () => {
  const first = makeOverseer()
  const second = makeOverseer()
  const received: number[] = []
  // The chat holds the second workspace's entries before this hook is given its overseer.
  const Probe = ({ overseer, held }: { overseer: RpcStub<Overseer>, held: RpcStub<Overseer> | null }) => {
    useActionEntries(held, () => {})
    useNewActionEntries(overseer, found => received.push(found.id))
    return null
  }
  await view.render(<Probe overseer={first.overseer} held={second.overseer} />)
  await second.emit(entry(1))

  await view.render(<Probe overseer={second.overseer} held={second.overseer} />)
  expect(received).toEqual([])

  await second.emit(entry(2))
  expect(received).toEqual([2])
})

it('leaves out the last change of a session it resumes, which is delivered again', async () => {
  const received: number[] = []
  const Probe = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
    useNewActionEntries(overseer, found => received.push(found.id))
    return null
  }
  const first = makeOverseer()
  linkActionLog(first.overseer, 'ws-new-entries')
  await view.render(<Probe overseer={first.overseer} />)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [] })
  await first.emit(entry(1))

  // The workspace is left and entered again, or its connection is lost and made again.
  const second = makeOverseer()
  linkActionLog(second.overseer, 'ws-new-entries')
  await view.render(<Probe overseer={second.overseer} />)
  await second.emit(entry(1))
  await second.emit(entry(2))

  expect(received).toEqual([1, 2])
})
