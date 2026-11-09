/* eslint-disable react/react-in-jsx-scope */

// Bob's side of a shared view, in Chromium: the three ways he can arrive (never signed in, checked
// and refused, live), and the explore dialog reached and worked from the keyboard. The gadget's own
// UI (GadgetUI, the same component in view and live mode) is mocked.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi, ConnectedAccountsSubscriber, GadgetAccessMode, GadgetClient,
  ObserverAccountChoice, ObserverBindingNeed, ObserverConfigCallback, Overseer,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('./GadgetUI', () => ({ default: () => <div data-testid="live-gadget" /> }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => <button type="button">Export</button> }))

import './styles.css'
import GadgetUseView from './GadgetUseView'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { readCardDismissed, writeCardDismissed, writeExploreMemory } from './features/shared-view/exploreMemory'

const WS = 'ws-billing'
const GADGET = 4
const NEED: ObserverBindingNeed = {
  gatekeeperId: 7, vendorId: 'bigquery', resourceTitle: 'finance.accounts', resourceUrl: '',
}
const BOB = 11

/** A pipelined RPC result: awaitable and disposable. */
const rpc = <T,>(value: Promise<T>) => Object.assign(value, { [Symbol.dispose]() {} })

const viewGadget = () => ({
  getView: () => rpc(Promise.resolve({
    takenAt: new Date(),
    owner: { type: 'user', id: 'phillip@cloudflare.com', name: 'Phillip Jones' },
  })),
  getAccessMode: async () => 'view',
  dup() { return this },
  [Symbol.dispose]() {},
}) as unknown as RpcStub<GadgetClient>

const liveGadget = () => ({
  getAccessMode: async () => 'live',
  dup() { return this },
  [Symbol.dispose]() {},
}) as unknown as RpcStub<GadgetClient>

/**
 * The explore check as the server runs it: ask for accounts, then either admit live or re-ask
 * with the refused source marked failed. `allow` decides which.
 */
function fakeOverseer(allow: boolean) {
  const tried: ObserverAccountChoice[][] = []
  const overseer = {
    getGadget: (_id: number, callback: RpcStub<ObserverConfigCallback>) => rpc((async () => {
      const choices = await callback.configure([NEED])
      tried.push(choices)
      if (!allow) {
        await callback.configure([{ ...NEED, failure: { accountId: BOB, reason: 'Access denied' } }])
      }
      return allow ? liveGadget() : viewGadget()
    })()),
  } as unknown as RpcStub<Overseer>
  return { overseer, tried }
}

const authenticatedApi = {
  subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
    subscriber.add(BOB, { displayName: 'Bob', uniqueName: 'bob@cloudflare.com' } as AccountDescription,
      { displayName: 'BigQuery' } as VendorDescription, [], true, 'bigquery')
    subscriber.ready()
    return rpc(Promise.resolve({ [Symbol.dispose]() {} }))
  },
  listGatekeeperVendors: async () => [
    { id: 'bigquery', description: { displayName: 'BigQuery' }, supportedResources: [] }],
  listAddableGatekeepers: async () => [],
} as unknown as RpcStub<AuthenticatedApi>

let root: Root | undefined
let container: HTMLElement | undefined

async function render(
  gadget: RpcStub<GadgetClient>, mode: GadgetAccessMode, overseer: RpcStub<Overseer>,
  onGadgetLive = () => {},
) {
  container = document.body.appendChild(document.createElement('div'))
  container.style.height = '800px'
  root = createRoot(container)
  await act(async () => root!.render(
    <TooltipProvider><Toasty>
      <GadgetUseView
        overseer={overseer}
        gadget={gadget}
        gadgetMode={mode}
        workspaceId={WS}
        onGadgetLive={onGadgetLive}
        selectedGadgetId={GADGET}
        gadgetOpenFailure={null}
        onRetryGadget={() => {}}
        gadgets={[{ id: GADGET, title: 'Workers Paid billing' } as never]}
        onSelectGadget={() => {}}
        authenticatedApi={authenticatedApi}
        currentUserId="bob@cloudflare.com"
      />
    </Toasty></TooltipProvider>))
}

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

const card = (name: RegExp) => page.getByRole('button', { name })

beforeEach(() => localStorage.clear())

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe("Bob's view of a shared gadget", () => {
  it('shows the gadget itself, then one invitation; no export, no prompt', async () => {
    const { overseer } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)

    // The gadget's own UI, which the view client connects to the view's copy.
    await expect.element(page.getByTestId('live-gadget')).toBeInTheDocument()
    // One action whose name is the whole card: the offer, then whose view and when.
    await expect.element(card(/^A snapshot of what Phillip sees\. From today, \d{1,2}:\d\d(?: [AP]M)?\. Sign in to use it live\.$/))
      .toBeVisible()
    // No strip above the view: the card and the header chip carry the time.
    expect(page.getByText(/^As of /).query()).toBeNull()
    expect(page.getByText(/filters stay as/).query()).toBeNull()
    expect(page.getByRole('button', { name: 'Export' }).query()).toBeNull()
    expect(page.getByRole('dialog').query()).toBeNull()
  })

  it('after a refused check, states where Bob stands instead of asking again', async () => {
    writeExploreMemory(WS, GADGET, { mode: 'view', refusedChoices: [{ gatekeeperId: 7, accountId: BOB }] })
    const { overseer, tried } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)

    const checked = card(/^A snapshot of what Phillip sees\. From today, \d{1,2}:\d\d(?: [AP]M)?\. You don't have access to use it yet\.$/)
    await expect.element(checked).toBeVisible()
    // "See what's missing" re-checks the remembered account, unasked.
    await input(() => userEvent.click(checked))
    await expect.element(page.getByRole('heading', { name: "You'll keep seeing Phillip's snapshot" })).toBeVisible()
    expect(tried).toEqual([[{ gatekeeperId: 7, accountId: BOB }]])
    await expect.element(page.getByText("bob@cloudflare.com can't open finance.accounts.")).toBeVisible()
  })

  it('live: the gadget itself, unlabelled, with no card', async () => {
    const { overseer } = fakeOverseer(true)
    await render(liveGadget(), 'live', overseer)
    await expect.element(page.getByTestId('live-gadget')).toBeInTheDocument()
    expect(page.getByText('Live data').query()).toBeNull()
    expect(card(/Sign in to use it live\.$/).query()).toBeNull()
  })

  it('puts the card away into the header chip, which brings it back', async () => {
    const { overseer } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)
    await expect.element(card(/Sign in to use it live\.$/)).toBeVisible()
    await input(() => userEvent.click(page.getByRole('button', { name: 'Hide' })))
    expect(card(/Sign in to use it live\.$/).query()).toBeNull()
    const chip = page.getByRole('button', { name: /^Phillip's snapshot · today, \d{1,2}:\d\d(?: [AP]M)?$/ })
    await expect.element(chip).toBeVisible()
    expect(readCardDismissed(WS, GADGET)).toBe(true)

    await input(() => userEvent.click(chip))
    await expect.element(card(/Sign in to use it live\.$/)).toBeVisible()
    expect(readCardDismissed(WS, GADGET)).toBe(false)
  })

  it('stays put away on the next visit', async () => {
    writeCardDismissed(WS, GADGET, true)
    const { overseer } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)
    await expect.element(page.getByRole('button', { name: /^Phillip's snapshot · / })).toBeVisible()
    expect(card(/Sign in to use it live\.$/).query()).toBeNull()
  })
})

describe('the explore dialog', () => {
  async function openFromKeyboard() {
    const invitation = card(/Sign in to use it live\.$/)
    await expect.element(invitation).toBeVisible()
    ;(invitation.element() as HTMLElement).focus()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(page.getByRole('heading', { name: 'Use it live with Phillip' })).toBeVisible()
  }

  it('is worked in order from the keyboard, and success starts exploring', async () => {
    const { overseer } = fakeOverseer(true)
    const onGadgetLive = vi.fn<() => void>()
    await render(viewGadget(), 'view', overseer, onGadgetLive)
    await openFromKeyboard()

    await expect.element(page.getByText('finance.accounts')).toBeVisible()
    const proceed = page.getByRole('button', { name: 'Continue with BigQuery' })
    await expect.element(proceed).toHaveFocus()
    const order: string[] = []
    for (let presses = 0; presses < 3; presses++) {
      await input(() => userEvent.tab())
      order.push((document.activeElement as HTMLElement).textContent || document.activeElement!.getAttribute('aria-label')!)
    }
    expect(order).toEqual(['Close', 'Not now', 'Continue with BigQuery'])

    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(page.getByRole('heading', { name: "You're all set" })).toBeVisible()
    await expect.element(page.getByText('Has access')).toBeVisible()
    await expect.element(page.getByText('You can open everything this gadget uses.')).toBeVisible()
    const start = page.getByRole('button', { name: 'Start using it' })
    await expect.element(start).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))
    expect(onGadgetLive).toHaveBeenCalledOnce()
  })

  it('a refusal keeps the view, names the table and offers the access request', async () => {
    const { overseer } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)
    await openFromKeyboard()
    await input(() => userEvent.click(page.getByRole('button', { name: 'Continue with BigQuery' })))

    await expect.element(page.getByRole('heading', { name: "You'll keep seeing Phillip's snapshot" })).toBeVisible()
    await expect.element(page.getByText('No access')).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Copy access request' })).toBeVisible()
    const done = page.getByRole('button', { name: 'Done' })
    await expect.element(done).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))

    // Remembered: the card now states where Bob stands.
    await expect.element(card(/You don't have access to use it yet\.$/)).toBeVisible()
  })

  it('"Not now" closes it and changes nothing', async () => {
    const { overseer } = fakeOverseer(false)
    await render(viewGadget(), 'view', overseer)
    await openFromKeyboard()
    await input(() => userEvent.click(page.getByRole('button', { name: 'Not now' })))
    expect(page.getByRole('dialog').query()).toBeNull()
    await expect.element(card(/Sign in to use it live\.$/)).toBeVisible()
  })
})
