// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toasty, useKumoToastManager } from '@cloudflare/kumo'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { UPDATE_NOTICE_DISMISSED_AT_KEY } from './updateNoticeDismissal'
import { testUpdateStatus } from './updateStatusFixture'

const testState = vi.hoisted(() => ({
  status: null as DeploymentUpdateStatus | null,
  navigate: vi.fn<(options: unknown) => Promise<void>>(),
}))

vi.mock('./useUpdateStatus', () => ({ useUpdateStatus: () => testState.status }))
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => testState.navigate,
}))

import { UpdateAvailableNotice } from './UpdateAvailableNotice'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const HOUR_MS = 60 * 60 * 1000

type ToastList = ReturnType<typeof useKumoToastManager>['toasts']

// Toasts render in a portal on the body, outside the test's container.
const button = (name: string) => {
  const match = [...document.body.querySelectorAll('button')]
    .find(candidate => (candidate.getAttribute('aria-label') ?? candidate.textContent?.trim()) === name)
  if (!match) throw new Error(`no ${name} button`)
  return match
}

describe('UpdateAvailableNotice', () => {
  let container: HTMLDivElement
  let root: Root
  let toasts: ToastList

  // Reads the provider's toast list, which keeps a closed toast (as "ending") until its exit
  // animation has run.
  const ToastProbe = () => {
    toasts = useKumoToastManager().toasts
    return null
  }
  const liveToasts = () => toasts.filter(toast => toast.transitionStatus !== 'ending')

  const render = async (status: DeploymentUpdateStatus | null, { mounted = true } = {}) => {
    testState.status = status
    await act(async () => {
      root.render(
        <StrictMode>
          <Toasty>
            {mounted && <UpdateAvailableNotice />}
            <ToastProbe />
          </Toasty>
        </StrictMode>,
      )
    })
  }

  beforeEach(() => {
    // jsdom has no animations, so a closed toast would leave the list at once. Holding every exit
    // animation open keeps it there as "ending", as a browser does for the length of the exit.
    Element.prototype.getAnimations = () => [{ finished: new Promise<never>(() => {}) } as unknown as Animation]
    toasts = []
    testState.navigate.mockReset()
    localStorage.clear()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    localStorage.clear()
    delete (Element.prototype as Partial<Element>).getAnimations
  })

  it('shows exactly one persistent toast when the status says to notify', async () => {
    await render(testUpdateStatus())

    expect(liveToasts()).toHaveLength(1)
    expect(liveToasts()[0]).toMatchObject({ title: 'Update available', timeout: 0 })
    expect(document.body.textContent).toContain('A newer release is available for this deployment.')
  })

  it('shows nothing when the status does not notify', async () => {
    await render(testUpdateStatus({ notify: false }))

    expect(liveToasts()).toHaveLength(0)
  })

  it('shows nothing to a non-admin or on a deployment the deploy flow did not install', async () => {
    await render(null)

    expect(liveToasts()).toHaveLength(0)
  })

  // The kernel never notifies for a modified deployment; the deploy flow would refuse the update.
  it('shows nothing for a modified deployment', async () => {
    await render(testUpdateStatus({ modified: true, notify: false }))

    expect(liveToasts()).toHaveLength(0)
  })

  it('shows nothing while a dismissal is inside the snooze period', async () => {
    localStorage.setItem(UPDATE_NOTICE_DISMISSED_AT_KEY, String(Date.now() - HOUR_MS))

    await render(testUpdateStatus({ noticeSnoozeHours: 24 }))

    expect(liveToasts()).toHaveLength(0)
  })

  it('shows the toast again once the snooze period is over', async () => {
    localStorage.setItem(UPDATE_NOTICE_DISMISSED_AT_KEY, String(Date.now() - 25 * HOUR_MS))

    await render(testUpdateStatus({ noticeSnoozeHours: 24 }))

    expect(liveToasts()).toHaveLength(1)
  })

  it('keeps the same single toast when the status is read again', async () => {
    await render(testUpdateStatus())
    const [shown] = liveToasts()

    await render(testUpdateStatus({ checkedAt: new Date('2026-10-04T08:00:00Z') }))

    expect(liveToasts()).toHaveLength(1)
    expect(liveToasts()[0].id).toBe(shown.id)
  })

  it('snoozes the notice when the admin closes it', async () => {
    await render(testUpdateStatus())
    const before = Date.now()

    await act(async () => { button('Close').click() })

    expect(liveToasts()).toHaveLength(0)
    const dismissedAt = Number(localStorage.getItem(UPDATE_NOTICE_DISMISSED_AT_KEY))
    expect(dismissedAt).toBeGreaterThanOrEqual(before)
    expect(dismissedAt).toBeLessThanOrEqual(Date.now())
  })

  it('withdraws the toast without snoozing when Home goes away', async () => {
    await render(testUpdateStatus())

    await render(testUpdateStatus(), { mounted: false })

    expect(liveToasts()).toHaveLength(0)
    expect(localStorage.getItem(UPDATE_NOTICE_DISMISSED_AT_KEY)).toBeNull()
  })

  it('withdraws the toast without snoozing when the status stops notifying', async () => {
    await render(testUpdateStatus())

    await render(testUpdateStatus({ notify: false }))

    expect(liveToasts()).toHaveLength(0)
    expect(localStorage.getItem(UPDATE_NOTICE_DISMISSED_AT_KEY)).toBeNull()
  })

  // The withdrawn toast is still on its way out when the next one is added.
  it('shows the toast again when the status notifies again', async () => {
    await render(testUpdateStatus())
    await render(testUpdateStatus({ notify: false }))

    await render(testUpdateStatus())

    expect(liveToasts()).toHaveLength(1)
  })

  it('opens the admin Updates tab from "View update" without snoozing', async () => {
    await render(testUpdateStatus())

    await act(async () => { button('View update').click() })

    expect(testState.navigate).toHaveBeenCalledTimes(1)
    expect(testState.navigate).toHaveBeenCalledWith({ to: '/admin', search: { tab: 'updates' } })
    expect(localStorage.getItem(UPDATE_NOTICE_DISMISSED_AT_KEY)).toBeNull()
  })
})
