// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: () => {} }
  return { ...actual, useKumoToastManager: () => toasts }
})
// The account modal is tested where it lives; here only whether it opens matters.
vi.mock('./components/CreationAccountModal', () => ({
  CreationAccountModal: () => <div data-testid="creation-account-modal" />,
}))

import {
  entry, makeOverseer, makeTestRoot, pushEntry, pushReviewDialog as dialog, settlePushReview as settle,
} from './action-test-harness'
import { useResolveAction } from './useResolveAction'

const view = makeTestRoot()
afterEach(() => view.cleanup())

const Host = ({ overseer, restricted, action }: {
  overseer: RpcStub<Overseer>
  restricted: boolean | undefined
  action: ActionLogEntry
}) => {
  const [, setProcessing] = useState<Set<number>>(new Set())
  const { resolveAction, reviewPush, creationAccountModal, pushReviewDialog } =
    useResolveAction(overseer, setProcessing, restricted)
  return (
    <>
      <button type="button" onClick={() => void resolveAction(action, 'approve')}>host approve</button>
      <button type="button" onClick={() => void resolveAction(action, 'deny')}>host deny</button>
      <button type="button" onClick={() => reviewPush(action)}>host review</button>
      {creationAccountModal}
      {pushReviewDialog}
    </>
  )
}

const mount = async (action: ActionLogEntry, restricted: boolean | undefined) => {
  const server = makeOverseer()
  await view.render(<Host overseer={server.overseer} restricted={restricted} action={action} />)
  return server
}

const press = async (label: string, within: ParentNode = document) => {
  const button = [...within.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (!button) throw new Error(`no "${label}" button`)
  await act(async () => button.click())
  await settle()
}

const dialogButton = (label: string) =>
  [...dialog()!.querySelectorAll('button')].find(button => button.textContent === label)

describe('a push in a restricted workspace', () => {
  it('opens the review instead of approving', async () => {
    const server = await mount(pushEntry(4), true)

    await press('host approve')

    expect(server.decisionCalls).toEqual([])
    expect(dialog()?.textContent).toContain('Review commits')
    expect(server.pushReviewCalls).toEqual([4])
  })

  it('approves from the review once it has loaded whole, with nothing opened', async () => {
    const server = await mount(pushEntry(4), true)
    await press('host approve')

    // Every page and the one file listed as text have loaded; no file was selected.
    expect(dialog()!.textContent).toContain('The whole review has loaded: 1 commit and 1 file.')
    expect(dialogButton('Approve')!.disabled).toBe(false)
    await press('Approve', dialog()!)

    expect(server.decisionCalls).toEqual(['approve:4'])
    expect(dialog()).toBeNull()
  })

  it('denies from the review', async () => {
    const server = await mount(pushEntry(4), true)
    await press('host approve')

    await press('Deny', dialog()!)

    expect(server.decisionCalls).toEqual(['reject:4'])
    expect(dialog()).toBeNull()
  })

  it('denies directly, without the review', async () => {
    const server = await mount(pushEntry(4), true)

    await press('host deny')

    expect(server.decisionCalls).toEqual(['reject:4'])
    expect(dialog()).toBeNull()
  })

  it('approves a request that is not a push directly', async () => {
    const server = await mount(entry(4), true)

    await press('host approve')

    expect(server.decisionCalls).toEqual(['approve:4'])
    expect(dialog()).toBeNull()
  })

  it('still asks which account a creation goes to', async () => {
    const server = await mount(entry(4, { gatekeeperId: 7, creation: true }), true)

    await press('host approve')

    expect(server.decisionCalls).toEqual([])
    expect(document.querySelector('[data-testid="creation-account-modal"]')).not.toBeNull()
  })
})

describe('a push in an unrestricted workspace', () => {
  it('approves directly', async () => {
    const server = await mount(pushEntry(4), false)

    await press('host approve')

    expect(server.decisionCalls).toEqual(['approve:4'])
    expect(dialog()).toBeNull()
  })

  it('opens the review as an offer, which decides nothing', async () => {
    const server = await mount(pushEntry(4), false)

    await press('host review')

    expect(dialog()?.textContent).toContain('Review commits')
    expect(dialogButton('Approve')).toBeUndefined()
    expect(dialogButton('Deny')).toBeUndefined()
    expect(server.decisionCalls).toEqual([])
  })

  it('opens no review for a request that is not a push', async () => {
    const server = await mount(entry(4), false)

    await press('host review')

    expect(dialog()).toBeNull()
    expect(server.pushReviewCalls).toEqual([])
  })
})

describe('a workspace whose mark is not known yet', () => {
  it('approves a push directly, as an unrestricted one does', async () => {
    const server = await mount(pushEntry(4), undefined)

    await press('host approve')

    expect(server.decisionCalls).toEqual(['approve:4'])
    expect(dialog()).toBeNull()
  })

  it('has to be said: a host that leaves the mark out does not compile', () => {
    const Unsaid = ({ overseer }: { overseer: RpcStub<Overseer> }) => {
      // @ts-expect-error `restricted` is required, so no host approves a restricted push unasked.
      useResolveAction(overseer, () => {})
      return null
    }
    expect(Unsaid).toBeTypeOf('function')
  })
})
