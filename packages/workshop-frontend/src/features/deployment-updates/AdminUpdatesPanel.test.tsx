// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import { MAX_UPDATE_HOURS } from '@gadgets/workshop-shared/api'
import type { AdminApi, DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { testUpdateStatus } from './updateStatusFixture'

const { addToast } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

import { AdminUpdatesPanel } from './AdminUpdatesPanel'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const CHECKS_LABEL = 'Check for updates automatically'
const MINIMUM_AGE_LABEL = 'Minimum release age (hours)'
const SNOOZE_LABEL = 'Hide a closed notice for (hours)'

// Each hour field, with the setter that saves it and the status field that reports it.
const HOUR_FIELDS = [
  { label: MINIMUM_AGE_LABEL, setter: 'setUpdateMinimumAgeHours', reported: 'minimumAgeHours' },
  { label: SNOOZE_LABEL, setter: 'setUpdateNoticeSnoozeHours', reported: 'noticeSnoozeHours' },
] as const

const fakeAdmin = () => ({
  setUpdateChecksEnabled: vi.fn<AdminApi['setUpdateChecksEnabled']>(async () => {}),
  setUpdateMinimumAgeHours: vi.fn<AdminApi['setUpdateMinimumAgeHours']>(async () => {}),
  setUpdateNoticeSnoozeHours: vi.fn<AdminApi['setUpdateNoticeSnoozeHours']>(async () => {}),
  checkForUpdates: vi.fn<AdminApi['checkForUpdates']>(async () => testUpdateStatus()),
})

const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const click = (element: HTMLElement) => act(async () => { element.click() })

const focus = (element: HTMLElement) => act(async () => { element.focus() })

// What a browser does to a control with focus that a call disables. jsdom leaves focus on such a
// control and won't blur it either, so focus leaves by way of a button that takes it and goes.
const dropFocus = () => act(async () => {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.blur()
  elsewhere.remove()
})

describe('AdminUpdatesPanel', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (status: DeploymentUpdateStatus = testUpdateStatus()) => {
    const admin = fakeAdmin()
    const onChanged = vi.fn<() => Promise<void>>(async () => {})
    // Shows what a re-read of the status reported.
    const show = (reported: DeploymentUpdateStatus) => act(async () => root.render(
      <AdminUpdatesPanel
        admin={admin as unknown as RpcStub<AdminApi>}
        status={reported}
        onChanged={onChanged}
      />))
    await show(status)
    return { ...admin, onChanged, show }
  }

  // The value shown beside each label of the panel's description list.
  const field = (label: string) => {
    const term = [...container.querySelectorAll('dt')].find(dt => dt.textContent === label)
    if (!term) throw new Error(`no ${label} field`)
    return term.nextElementSibling?.textContent
  }

  const updateLink = () =>
    [...container.querySelectorAll('a')].find(link => link.textContent?.trim() === 'Update')

  const button = (name: string) => {
    const element = [...container.querySelectorAll('button')]
      .find((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name)
    if (!element) throw new Error(`no button ${name}`)
    return element
  }

  const checksSwitch = () => {
    const element = button(CHECKS_LABEL)
    if (element.getAttribute('role') !== 'switch') throw new Error('not a switch')
    return element
  }

  // The checkbox the switch forwards its clicks to. jsdom has no PointerEvent, which the switch
  // forwards them with.
  const checksCheckbox = () => {
    const input = checksSwitch().nextElementSibling
    if (!(input instanceof HTMLInputElement)) throw new Error('no checkbox behind the switch')
    return input
  }

  const labeledInput = (label: string) => {
    const labelElement = [...container.querySelectorAll('label')]
      .find((element) => element.textContent?.startsWith(label))
    if (!labelElement) throw new Error(`no label ${label}`)
    const element = document.getElementById(labelElement.htmlFor)
    if (!(element instanceof HTMLInputElement)) throw new Error(`no input labeled ${label}`)
    return element
  }

  const saveButton = (label: string) => button(`Save “${label}”`)

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    addToast.mockReset()
    vi.restoreAllMocks()
  })

  describe('release', () => {
    it('shows the running and newest release, when it was checked, and that an update is available', async () => {
      const checkedAt = new Date('2026-10-03T12:30:00Z')

      await render(testUpdateStatus({
        currentReleaseId: 'r100-aaaaaaa',
        latestReleaseId: 'r101-bbbbbbb',
        checkedAt,
      }))

      expect(field('Running release')).toBe('r100-aaaaaaa')
      expect(field('Newest release')).toBe('r101-bbbbbbb')
      expect(field('Last checked')).toBe(formatFullTimestamp(checkedAt))
      expect(field('Update available')).toBe('Yes')
    })

    it('says when the deployment already runs the newest release', async () => {
      await render(testUpdateStatus({
        latestReleaseId: 'r100-aaaaaaa',
        updateAvailable: false,
        availableSince: undefined,
        notify: false,
      }))

      expect(field('Update available')).toBe('No')
    })

    it('says that nothing is known before a check has succeeded', async () => {
      await render(testUpdateStatus({
        latestReleaseId: undefined,
        updateAvailable: false,
        availableSince: undefined,
        notify: false,
        checkedAt: undefined,
      }))

      expect(field('Running release')).toBe('r100-aaaaaaa')
      expect(field('Newest release')).toBe('No check has succeeded yet')
      expect(field('Last checked')).toBe('Never')
      expect(field('Update available')).toBe('Not known until a check succeeds')
    })

    it('links Update to the deploy flow in a new tab', async () => {
      const updateUrl = 'https://deploy.example.com/#flow=upgrade&account=acct&installation=0123abcd&name=os'

      await render(testUpdateStatus({ updateUrl }))

      const link = updateLink()
      expect(link?.getAttribute('href')).toBe(updateUrl)
      expect(link?.getAttribute('target')).toBe('_blank')
      expect(link?.getAttribute('rel')).toContain('noopener')
    })

    // The deploy flow, not this page, decides whether there is anything to install.
    it('offers Update when no update is known', async () => {
      await render(testUpdateStatus({ updateAvailable: false, notify: false }))

      expect(updateLink()).toBeDefined()
    })

    it.each([
      'javascript:alert(1)',
      'data:text/html,<p>hi</p>',
      '/#flow=upgrade',
      'not a url',
      '',
    ])('renders no Update link for %j', async (updateUrl) => {
      await render(testUpdateStatus({ updateUrl }))

      expect(updateLink()).toBeUndefined()
      expect(container.querySelector('a')).toBeNull()
    })

    it('warns, as an alert, that a modified deployment cannot be upgraded', async () => {
      await render(testUpdateStatus({ modified: true, notify: false }))

      const alert = container.querySelector('[role="alert"]')
      expect(alert?.textContent).toContain('This deployment was changed outside the deploy flow')
      expect(alert?.textContent).toContain('refuse to upgrade')
      // Still offered: the deploy flow explains the refusal itself.
      expect(updateLink()).toBeDefined()
    })

    it('shows no warning for an unmodified deployment', async () => {
      await render(testUpdateStatus({ modified: false }))

      expect(container.querySelector('[role="alert"]')).toBeNull()
    })
  })

  describe('Check now', () => {
    it('asks for the newest release, then re-reads the status', async () => {
      const { checkForUpdates, onChanged } = await render()

      await click(button('Check now'))

      expect(checkForUpdates).toHaveBeenCalledOnce()
      expect(onChanged).toHaveBeenCalledOnce()
      expect(checkForUpdates.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
    })

    it('announces the update a check found', async () => {
      const { checkForUpdates } = await render(testUpdateStatus({
        latestReleaseId: 'r100-aaaaaaa',
        updateAvailable: false,
        availableSince: undefined,
        notify: false,
      }))
      checkForUpdates.mockResolvedValueOnce(testUpdateStatus({ latestReleaseId: 'r102-ccccccc' }))

      await click(button('Check now'))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Update available: release r102-ccccccc',
        variant: 'success',
      })
    })

    it('announces that a check found no update', async () => {
      const { checkForUpdates } = await render()
      checkForUpdates.mockResolvedValueOnce(testUpdateStatus({
        latestReleaseId: 'r100-aaaaaaa',
        updateAvailable: false,
        availableSince: undefined,
        notify: false,
      }))

      await click(button('Check now'))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'No update available: this deployment runs the newest release',
        variant: 'success',
      })
    })

    // The re-read hides the tab of a deployment the deploy flow no longer claims.
    it('announces nothing when the deployment is no longer installed by the deploy flow', async () => {
      const { checkForUpdates, onChanged } = await render()
      checkForUpdates.mockResolvedValueOnce(null)

      await click(button('Check now'))

      expect(addToast).not.toHaveBeenCalled()
      expect(onChanged).toHaveBeenCalledOnce()
    })

    // Automatic checks being off is what Check now is for.
    it('asks while automatic checks are off', async () => {
      const { checkForUpdates } = await render(testUpdateStatus({ checksEnabled: false, notify: false }))

      await click(button('Check now'))

      expect(checkForUpdates).toHaveBeenCalledOnce()
    })

    it('cannot be pressed again while a check is in flight', async () => {
      const { checkForUpdates } = await render()
      const call = deferred<DeploymentUpdateStatus | null>()
      checkForUpdates.mockReturnValueOnce(call.promise)

      await click(button('Check now'))

      expect(button('Check now').disabled).toBe(true)
      await click(button('Check now'))
      expect(checkForUpdates).toHaveBeenCalledOnce()

      await act(async () => call.resolve(testUpdateStatus()))

      expect(button('Check now').disabled).toBe(false)
    })

    it('reports a failed check with the server’s message and re-reads nothing', async () => {
      const { checkForUpdates, onChanged } = await render()
      checkForUpdates.mockRejectedValueOnce(new Error('The update check answered 503.'))

      await click(button('Check now'))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: 'Couldn’t check for updates',
        description: 'The update check answered 503.',
        variant: 'error',
      })
      expect(onChanged).not.toHaveBeenCalled()
      expect(button('Check now').disabled).toBe(false)
    })

    it('reports a failed re-read after a check that went through', async () => {
      const { onChanged } = await render()
      onChanged.mockRejectedValueOnce(new Error('Admin settings are unavailable.'))

      await click(button('Check now'))

      expect(addToast).toHaveBeenCalledTimes(2)
      expect(addToast).toHaveBeenLastCalledWith(expect.objectContaining({
        title: 'Couldn’t reload the update status',
        variant: 'error',
      }))
    })
  })

  describe('automatic update checks', () => {
    it.each([true, false])('shows %s as the server reported it, with what it means', async (enabled) => {
      await render(testUpdateStatus({ checksEnabled: enabled }))

      expect(checksSwitch().getAttribute('aria-checked')).toBe(String(enabled))
      const meaning = document.getElementById(checksSwitch().getAttribute('aria-describedby')!)
      expect(meaning?.textContent).toContain('it asks only when an admin chooses Check now')
    })

    it.each([true, false])('sets the opposite of %s, then re-reads the status', async (enabled) => {
      const { setUpdateChecksEnabled, onChanged } = await render(testUpdateStatus({ checksEnabled: enabled }))

      await click(checksCheckbox())

      expect(setUpdateChecksEnabled).toHaveBeenCalledExactlyOnceWith(!enabled)
      expect(onChanged).toHaveBeenCalledOnce()
      expect(setUpdateChecksEnabled.mock.invocationCallOrder[0])
        .toBeLessThan(onChanged.mock.invocationCallOrder[0])
      // The re-read is what moves the switch.
      expect(checksSwitch().getAttribute('aria-checked')).toBe(String(enabled))
    })

    it('cannot be changed again while the change is in flight', async () => {
      const { setUpdateChecksEnabled } = await render()
      const call = deferred()
      setUpdateChecksEnabled.mockReturnValueOnce(call.promise)

      await click(checksCheckbox())

      expect(checksSwitch().disabled).toBe(true)
      await click(checksCheckbox())
      expect(setUpdateChecksEnabled).toHaveBeenCalledOnce()

      await act(async () => call.resolve())

      expect(checksSwitch().disabled).toBe(false)
    })

    it('reports a refused change with the server’s message and keeps showing the server’s value', async () => {
      const { setUpdateChecksEnabled, onChanged } = await render()
      setUpdateChecksEnabled.mockRejectedValueOnce(new Error('Admin settings are unavailable.'))

      await click(checksCheckbox())

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Couldn’t update “${CHECKS_LABEL}”`,
        description: 'Admin settings are unavailable.',
        variant: 'error',
      })
      expect(onChanged).not.toHaveBeenCalled()
      expect(checksSwitch().getAttribute('aria-checked')).toBe('true')
      expect(checksSwitch().disabled).toBe(false)
    })
  })

  describe.each(HOUR_FIELDS)('$label', ({ label, setter, reported }) => {
    it('shows the server’s hours, with what they mean', async () => {
      await render(testUpdateStatus({ [reported]: 36 }))

      expect(labeledInput(label).value).toBe('36')
      const described = (labeledInput(label).getAttribute('aria-describedby') ?? '').split(' ')
        .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
      expect(described).toContain(reported === 'minimumAgeHours'
        ? 'Update always installs the newest release'
        : '0 means a closed notice comes back on the next visit to Home')
    })

    it.each(['0', '48', String(MAX_UPDATE_HOURS)])('saves %s hours, then re-reads the status', async (hours) => {
      const admin = await render()

      await type(labeledInput(label), hours)
      await click(saveButton(label))

      expect(admin[setter]).toHaveBeenCalledExactlyOnceWith(Number(hours))
      expect(admin.onChanged).toHaveBeenCalledOnce()
      expect(admin[setter].mock.invocationCallOrder[0])
        .toBeLessThan(admin.onChanged.mock.invocationCallOrder[0])
    })

    it('saves only its own field', async () => {
      const admin = await render()
      const other = HOUR_FIELDS.find((entry) => entry.label !== label)!

      await type(labeledInput(label), '48')
      await click(saveButton(label))

      expect(admin[other.setter]).not.toHaveBeenCalled()
    })

    it('reports a refused save with the server’s message and keeps what was typed', async () => {
      const admin = await render()
      admin[setter].mockRejectedValueOnce(new Error('Admin settings are unavailable.'))

      await type(labeledInput(label), '48')
      await click(saveButton(label))

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Couldn’t update “${label}”`,
        description: 'Admin settings are unavailable.',
        variant: 'error',
      })
      expect(admin.onChanged).not.toHaveBeenCalled()
      expect(labeledInput(label).value).toBe('48')
      expect(labeledInput(label).disabled).toBe(false)
    })

    // The hours the field would fall back to are the ones the save replaced.
    it('keeps showing the saved hours when the re-read after the save fails, and saves them again', async () => {
      const admin = await render(testUpdateStatus({ [reported]: 24 }))
      admin.onChanged.mockRejectedValueOnce(new Error('Admin settings are unavailable.'))

      await type(labeledInput(label), '48')
      await click(saveButton(label))

      expect(addToast).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        title: 'Couldn’t reload the update status',
        variant: 'error',
      }))
      expect(labeledInput(label).value).toBe('48')

      await click(saveButton(label))

      expect(admin[setter]).toHaveBeenCalledTimes(2)
      expect(admin[setter]).toHaveBeenLastCalledWith(48)
    })
  })

  // The switch and Check now are disabled for as long as their call takes, and a disabled control
  // loses focus.
  describe('focus across a call', () => {
    it('returns to the switch that was turned', async () => {
      const { setUpdateChecksEnabled } = await render()
      const call = deferred()
      setUpdateChecksEnabled.mockReturnValueOnce(call.promise)

      await focus(checksSwitch())
      await click(checksCheckbox())
      await dropFocus()
      expect(checksSwitch().disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(checksSwitch())
    })

    it('returns to Check now once its check fails', async () => {
      const { checkForUpdates } = await render()
      const call = deferred<DeploymentUpdateStatus | null>()
      checkForUpdates.mockReturnValueOnce(call.promise)

      await focus(button('Check now'))
      await click(button('Check now'))
      await dropFocus()
      expect(button('Check now').disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.reject(new Error('The update check answered 503.')))

      expect(document.activeElement).toBe(button('Check now'))
    })

    it('returns to the Save button of an hour field', async () => {
      const { setUpdateMinimumAgeHours } = await render()
      const call = deferred()
      setUpdateMinimumAgeHours.mockReturnValueOnce(call.promise)
      await type(labeledInput(MINIMUM_AGE_LABEL), '48')

      await focus(saveButton(MINIMUM_AGE_LABEL))
      await click(saveButton(MINIMUM_AGE_LABEL))
      await dropFocus()
      expect(saveButton(MINIMUM_AGE_LABEL).disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => call.resolve())

      expect(document.activeElement).toBe(saveButton(MINIMUM_AGE_LABEL))
    })
  })
})
