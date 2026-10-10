// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})

vi.mock('./AuthContext', () => {
  const context = { authenticatedApi: { listGatekeeperVendors: async () => [] }, currentUser: null }
  return { useAuthenticatedApi: () => context, useOptionalAuthenticatedApi: () => context }
})

import { makeTestRoot } from './action-test-harness'
import Connections from './Connections'

const view = makeTestRoot()

beforeEach(() => {
  addToast.mockClear()
})

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const hook = {
  id: 7,
  gatekeeperId: 'github',
  gadgetId: 'triage',
  resourceTitle: 'acme/widgets',
  description: { title: 'Watch acme/widgets on GitHub', description: 'Call this hook with each issue event.' },
  enabled: false,
} as unknown as BoundHookInfo

const refusal = "GitHub refused to add a webhook to acme/widgets: only the repository's admins can."

const toggle = () => document.querySelector('[aria-label="Enable hook"], [aria-label="Disable hook"]')

it.each([
  ['says why GitHub refused it', new Error(refusal), refusal],
  ['leaves out a dropped connection’s transport message', new Error('Peer closed WebSocket: 1006 '), undefined],
])('a hook that fails to enable %s, and turns its toggle back off', async (_, failure, description) => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const overseer = {
    listHooks: async () => [hook],
    enableHook: async () => { throw failure },
    [Symbol.dispose]: () => {},
  }
  const gadget = { getId: async () => 'triage', getTitle: async () => 'Triage', listBindings: async () => [] }
  const authenticatedApi = { listGatekeeperVendors: async () => [] }
  await view.render(
    <Connections overseer={overseer as never} gadget={gadget as never} authenticatedApi={authenticatedApi as never} />,
  )
  await act(async () => {})

  // The checkbox the switch forwards its clicks to. jsdom has no PointerEvent, which the switch
  // forwards them with.
  const checkbox = toggle()?.nextElementSibling
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('No hook toggle rendered')
  await act(async () => checkbox.click())

  expect(addToast).toHaveBeenCalledExactlyOnceWith({ title: 'Failed to enable hook', description, variant: 'error' })
  expect(toggle()?.getAttribute('aria-label')).toBe('Enable hook')
})
