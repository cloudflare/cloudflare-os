// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountsSubscriberAdapter } from '../../accountsSubscriber'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: () => {} }
  return { ...actual, useKumoToastManager: () => toasts }
})

import { makeTestRoot } from '../../action-test-harness'
import type { AccountConnectionInfo } from '@gadgets/workshop-shared/api'
import { useAccountSignIn, type SignInAccount } from './useAccountSignIn'

const view = makeTestRoot()
afterEach(() => view.cleanup())

const GOOGLE = 4

function setup() {
  let subscriber!: AccountsSubscriberAdapter
  const authenticatedApi = {
    subscribeConnectedAccounts: (given: AccountsSubscriberAdapter) => {
      subscriber = given
      return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
    },
  }
  const overseer = {
    listAccountConnections: vi.fn<() => Promise<AccountConnectionInfo[]>>(async () => [
      { target: 1, resourceTitle: 'Launch plan', accountId: GOOGLE },
      { target: 2, resourceTitle: 'Budget', accountId: GOOGLE },
    ]),
  }
  const Probe = () => (
    <output>{JSON.stringify(useAccountSignIn(overseer as never, authenticatedApi as never).accounts)}</output>
  )
  const accounts = (): SignInAccount[] => JSON.parse(document.querySelector('output')!.textContent!)
  const report = async (credentialsValid: boolean) => act(async () => {
    subscriber.add(GOOGLE, { uniqueName: 'alex@acme.com' } as never,
      { displayName: 'Google' } as never, [], credentialsValid, 'google')
  })
  return { Probe, overseer, report, accounts }
}

it('asks nothing of the workspace while every account is signed in', async () => {
  const { Probe, overseer, report, accounts } = setup()
  await view.render(<Probe />)
  await report(true)

  expect(overseer.listAccountConnections).not.toHaveBeenCalled()
  expect(accounts()).toEqual([])
})

it('lists a signed-out account with the connections that use it, until it is signed in again', async () => {
  const { Probe, report, accounts } = setup()
  await view.render(<Probe />)
  await report(true)
  await report(false)

  expect(accounts()).toEqual([{
    id: GOOGLE, vendorName: 'Google',
    identity: 'alex@acme.com', phase: 'signedOut',
    connections: [{ target: 1, resourceTitle: 'Launch plan' }, { target: 2, resourceTitle: 'Budget' }],
  }])

  await report(true)
  expect(accounts()).toEqual([])
})
