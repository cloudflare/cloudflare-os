// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_WRITE_ACTIONS,
  ADMIN_WRITE_ERROR_CODES,
  createAdminWriteError,
  MAX_ADMIN_PASSKEY_NAME_LENGTH,
  MAX_ADMIN_PASSKEYS,
  type AdminApi,
  type AdminPasskey,
  type AdminPasskeyAssertion,
  type AdminPasskeyChallenge,
  type AdminPasskeyRegistration,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import type * as PasskeyCeremony from './passkeyCeremony'
import { WRITE_ACTION_LABELS } from './writeLabels'

const { addToast, createPasskey, assertPasskey } = vi.hoisted(() => ({
  addToast: vi.fn<(toast: { title: string; description?: string; variant: string }) => void>(),
  createPasskey: vi.fn<typeof PasskeyCeremony.createPasskey>(),
  assertPasskey: vi.fn<typeof PasskeyCeremony.assertPasskey>(),
}))

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cloudflare/kumo')>()),
  useKumoToastManager: () => ({ add: addToast }),
}))

vi.mock('./passkeyCeremony', async (importOriginal) => ({
  ...(await importOriginal<typeof PasskeyCeremony>()),
  createPasskey,
  assertPasskey,
}))

import { AdminPasskeysCard } from './AdminPasskeysCard'
import { PasskeyCeremonyError } from './passkeyCeremony'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const USER = { id: 'alice', name: 'Alice' }

const challenge = (text: string, credentialIds: string[] = []): AdminPasskeyChallenge => ({
  challenge: text,
  rpId: 'workshop.example',
  credentialIds,
  expiresAt: new Date('2026-01-15T12:05:00Z'),
})
const ENROLMENT_CHALLENGE = challenge('enrolment')
const REMOVAL_CHALLENGE = challenge('removal', ['alices-laptop'])
const REGISTRATION: AdminPasskeyRegistration = {
  credentialId: 'alices-phone',
  clientDataJSON: 'client-data',
  authenticatorData: 'authenticator-data',
  publicKey: 'public-key',
  publicKeyAlgorithm: -7,
}
const ASSERTION: AdminPasskeyAssertion = {
  credentialId: 'alices-laptop',
  clientDataJSON: 'client-data',
  authenticatorData: 'authenticator-data',
  signature: 'signature',
}

const ALICES: AdminPasskey = {
  id: 'alices-laptop', admin: 'alice', name: 'Work laptop', created: new Date('2026-01-10T09:00:00Z'),
}
const ALICES_PHONE: AdminPasskey = {
  id: 'alices-phone', admin: 'alice', name: 'Phone', created: new Date('2026-01-12T09:00:00Z'),
}
const BOBS = {
  id: 'bobs-key', admin: 'bob', name: 'Security key', created: new Date('2026-01-11T09:00:00Z'),
  lastUsed: new Date('2026-01-12T09:00:00Z'),
} satisfies AdminPasskey

// An AdminApi that holds passkeys as the server does: what is added or removed shows in the next
// listing.
const fakeAdmin = (enrolled: AdminPasskey[] = []) => {
  let passkeys = enrolled
  return {
    listAdminPasskeys: vi.fn<AdminApi['listAdminPasskeys']>(async () => passkeys),
    beginAdminPasskeyEnrolment: vi.fn<AdminApi['beginAdminPasskeyEnrolment']>(async () => ENROLMENT_CHALLENGE),
    addAdminPasskey: vi.fn<AdminApi['addAdminPasskey']>(async (name, registration) => {
      const added = { id: registration.credentialId, admin: USER.id, name, created: new Date('2026-01-15T12:00:00Z') }
      passkeys = [...passkeys, added]
      return added
    }),
    beginAdminPasskeyRemoval: vi.fn<AdminApi['beginAdminPasskeyRemoval']>(async () => REMOVAL_CHALLENGE),
    removeAdminPasskey: vi.fn<AdminApi['removeAdminPasskey']>(async (id) => {
      passkeys = passkeys.filter((passkey) => passkey.id !== id)
    }),
  }
}

// Whether each of these was last called after the one before it.
const calledInOrder = (...mocks: { mock: { invocationCallOrder: number[] } }[]) => {
  const order = mocks.map(({ mock }) => mock.invocationCallOrder.at(-1) ?? Number.NaN)
  return order.every((at, index) => index === 0 || at > order[index - 1])
}

// A button by its accessible name, in the card or in the dialog it opens.
const findButton = (name: string) => [...document.body.querySelectorAll('button')]
  .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
const button = (name: string) => {
  const element = findButton(name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}

const click = (element: HTMLElement) => act(async () => { element.click() })

const focus = (element: HTMLElement) => act(async () => { element.focus() })

// What a browser does to a control with focus that an operation disables. jsdom leaves focus on
// such a control and won't blur it either, so focus leaves by way of a button that takes it and
// goes.
const dropFocus = () => act(async () => {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.blur()
  elsewhere.remove()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const alerts = () => [...document.body.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)

// What a cell holds for an instant: the instant it marks, and the text it shows for it.
const when = (at: Date) => ({ at: at.toISOString(), shown: formatFullTimestamp(at) })

const dialog = () => document.body.querySelector('[role="dialog"]')

// A dialog takes focus a frame after it opens, from wherever focus is by then. A test that
// follows focus through a dialog waits for that first, or the frame can land in the middle of it.
const dialogTakesFocus = () => act(() => vi.waitFor(() => {
  expect(dialog()?.contains(document.activeElement)).toBe(true)
}, { interval: 5 }))

describe('AdminPasskeysCard', () => {
  let container: HTMLDivElement
  let root: Root

  const renderWith = async (admin: ReturnType<typeof fakeAdmin>, { writesOn = true } = {}) => {
    await act(async () => root.render(
      <AdminPasskeysCard
        admin={admin as unknown as RpcStub<AdminApi>}
        user={USER}
        siteName="Example OS"
        writesOn={writesOn}
      />))
    return admin
  }

  const render = (enrolled: AdminPasskey[] = [], options?: { writesOn?: boolean }) =>
    renderWith(fakeAdmin(enrolled), options)

  const nameInput = () => {
    const label = [...container.querySelectorAll('label')]
      .find((element) => element.textContent?.startsWith('Passkey name'))
    return label?.control instanceof HTMLInputElement ? label.control : undefined
  }

  const type = (value: string) => act(() => {
    const element = nameInput()!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })

  const rows = () => [...container.querySelectorAll('tbody tr')]
    .map((row) => [...row.querySelectorAll('td')].slice(0, 4).map((cell) => cell.textContent))

  // A row's Enrolled and Last used cells, each as `when` describes it, or as its text when it marks
  // no instant.
  const whens = () => [...container.querySelectorAll('tbody tr')]
    .map((row) => [...row.querySelectorAll('td')].slice(2, 4).map((cell) => {
      const time = cell.querySelector('time')
      return time ? { at: time.dateTime, shown: time.textContent } : cell.textContent
    }))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    createPasskey.mockResolvedValue(REGISTRATION)
    assertPasskey.mockResolvedValue(ASSERTION)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    addToast.mockReset()
    createPasskey.mockReset()
    assertPasskey.mockReset()
    vi.restoreAllMocks()
  })

  describe('while writes are on', () => {
    it('lists every admin\'s passkeys and offers Remove only on the caller\'s own', async () => {
      await render([ALICES, BOBS])

      expect(rows().map(([name, admin]) => [name, admin])).toEqual([
        ['Work laptop', 'alice'],
        ['Security key', 'bob'],
      ])
      expect(whens()).toEqual([
        [when(ALICES.created), 'Never'],
        [when(BOBS.created), when(BOBS.lastUsed)],
      ])
      expect(findButton('Remove passkey Work laptop')).toBeDefined()
      expect(findButton('Remove passkey Security key')).toBeUndefined()
      expect(container.textContent).toContain('A passkey works only for the admin it belongs to.')
    })

    it('names every write a passkey approves, and no other', async () => {
      await render()

      const named = /change a workspace \(([^)]*)\)/.exec(container.textContent ?? '')?.[1]
      expect(named?.split(', ')).toEqual(
        ADMIN_WRITE_ACTIONS.map((action) => WRITE_ACTION_LABELS[action].toLowerCase()))
    })

    it('says so when no passkey is enrolled', async () => {
      await render()

      expect(container.textContent).toContain('No passkey is enrolled yet.')
      expect(container.querySelector('table')).toBeNull()
    })

    it('keeps the add button disabled for a blank name', async () => {
      await render()
      expect(nameInput()!.maxLength).toBe(MAX_ADMIN_PASSKEY_NAME_LENGTH)
      expect(button('Add passkey').disabled).toBe(true)

      await type('   ')
      expect(button('Add passkey').disabled).toBe(true)

      await type('Phone')
      expect(button('Add passkey').disabled).toBe(false)
    })

    it('offers no enrolment to an admin who holds the most passkeys one may have', async () => {
      const held = (admin: string) => Array.from({ length: MAX_ADMIN_PASSKEYS }, (_, index) => (
        { ...ALICES, id: `${admin}-${index}`, admin, name: `Key ${index}` }))
      const admin = await render(held(USER.id))

      expect(nameInput()).toBeUndefined()
      expect(findButton('Add passkey')).toBeUndefined()
      expect(container.textContent).toContain(
        `You have enrolled ${MAX_ADMIN_PASSKEYS} passkeys, the most an admin may have.`)
      expect(admin.beginAdminPasskeyEnrolment).not.toHaveBeenCalled()

      // The limit is each admin's own: another admin's passkeys take none of the caller's places.
      await render([ALICES, ...held('bob')])
      expect(button('Add passkey')).toBeDefined()

      // One removed leaves a place.
      await render(held(USER.id).slice(1))
      expect(nameInput()).toBeDefined()
    })

    it('enrols a passkey under the trimmed name, then lists it and clears the name', async () => {
      const admin = await render([ALICES])
      await type('  Phone  ')

      await click(button('Add passkey'))

      expect(createPasskey).toHaveBeenCalledWith(ENROLMENT_CHALLENGE, USER, 'Example OS')
      expect(admin.addAdminPasskey).toHaveBeenCalledWith('Phone', REGISTRATION)
      expect(calledInOrder(admin.beginAdminPasskeyEnrolment, createPasskey, admin.addAdminPasskey,
        admin.listAdminPasskeys)).toBe(true)
      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(2)
      expect(rows().map(([name]) => name)).toEqual(['Work laptop', 'Phone'])
      expect(nameInput()!.value).toBe('')
      expect(document.activeElement).toBe(nameInput())
      expect(addToast).not.toHaveBeenCalled()
    })

    it('counts an enrolment as done when the passkeys cannot be listed again after it', async () => {
      const failure = new Error('unavailable')
      const admin = fakeAdmin([ALICES])
      admin.listAdminPasskeys.mockResolvedValueOnce([ALICES]).mockRejectedValueOnce(failure)
      await renderWith(admin)
      await type('Phone')

      await click(button('Add passkey'))

      expect(admin.addAdminPasskey).toHaveBeenCalledTimes(1)
      expect(console.error).toHaveBeenCalledWith('Failed to list the admin passkeys:', failure)
      expect(addToast).not.toHaveBeenCalled()
      expect(alerts()).toEqual([])
      expect(nameInput()!.value).toBe('')
      expect(rows().map(([name]) => name)).toEqual(['Work laptop'])
    })

    it('keeps the browser from submitting the form', async () => {
      await render()
      await type('Phone')
      // The form names no action, so a browser left to submit it would load the admin page again.
      let prevented: boolean | undefined
      document.addEventListener('submit', (event) => { prevented = event.defaultPrevented }, { once: true })

      await click(button('Add passkey'))

      expect(prevented).toBe(true)
    })

    it('stops quietly when the ceremony is cancelled, keeping the name', async () => {
      createPasskey.mockRejectedValue(new PasskeyCeremonyError('cancelled'))
      const admin = await render()
      await type('Phone')

      await click(button('Add passkey'))

      expect(admin.addAdminPasskey).not.toHaveBeenCalled()
      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(1)
      expect(addToast).not.toHaveBeenCalled()
      expect(alerts()).toEqual([])
      expect(nameInput()!.value).toBe('Phone')
      expect(button('Add passkey').disabled).toBe(false)
    })

    it('gives the add button its focus back when the ceremony is cancelled', async () => {
      const ceremony = deferred<AdminPasskeyRegistration>()
      createPasskey.mockReturnValue(ceremony.promise)
      await render()
      await type('Phone')

      await focus(button('Add passkey'))
      await click(button('Add passkey'))
      await dropFocus()
      expect(button('Add passkey').disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => ceremony.reject(new PasskeyCeremonyError('cancelled')))

      expect(document.activeElement).toBe(button('Add passkey'))
    })

    it('leaves focus where the admin moved it during the ceremony', async () => {
      const ceremony = deferred<AdminPasskeyRegistration>()
      createPasskey.mockReturnValue(ceremony.promise)
      await render()
      await type('Phone')

      await focus(button('Add passkey'))
      await click(button('Add passkey'))
      await focus(nameInput()!)

      await act(async () => ceremony.reject(new PasskeyCeremonyError('cancelled')))

      expect(document.activeElement).toBe(nameInput())
    })

    it('lets no passkey be removed while one is being enrolled', async () => {
      const ceremony = deferred<AdminPasskeyRegistration>()
      createPasskey.mockReturnValue(ceremony.promise)
      await render([ALICES])
      await type('Phone')

      await click(button('Add passkey'))
      expect(button('Remove passkey Work laptop').disabled).toBe(true)

      await act(async () => ceremony.reject(new PasskeyCeremonyError('cancelled')))
      expect(button('Remove passkey Work laptop').disabled).toBe(false)
    })

    it('says in place that the browser cannot use passkeys', async () => {
      createPasskey.mockRejectedValue(new PasskeyCeremonyError('unsupported'))
      const admin = await render()
      await type('Phone')

      await click(button('Add passkey'))

      expect(alerts()).toEqual(['This browser cannot use passkeys here.'])
      expect(admin.addAdminPasskey).not.toHaveBeenCalled()
      expect(addToast).not.toHaveBeenCalled()
    })

    it('says in place that the server did not accept the confirmation', async () => {
      const admin = await render()
      admin.addAdminPasskey.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.passkeyRefused))
      await type('Phone')

      await click(button('Add passkey'))

      expect(alerts()).toEqual(['The passkey confirmation was not accepted. Try again.'])
      expect(addToast).not.toHaveBeenCalled()

      // The next attempt starts with the message gone.
      admin.addAdminPasskey.mockResolvedValue({ ...ALICES, name: 'Phone' })
      await click(button('Add passkey'))
      expect(alerts()).toEqual([])
    })

    it('toasts any other refusal with the server\'s account of it', async () => {
      const admin = await render()
      admin.addAdminPasskey.mockRejectedValue(new Error('You have enrolled as many passkeys as an admin may.'))
      await type('Phone')

      await click(button('Add passkey'))

      expect(addToast).toHaveBeenCalledWith({
        title: 'Couldn’t enrol the passkey',
        description: 'You have enrolled as many passkeys as an admin may.',
        variant: 'error',
      })
      expect(alerts()).toEqual([])
      expect(nameInput()!.value).toBe('Phone')
    })

    it('toasts a coded refusal that is not of the confirmation, before any ceremony', async () => {
      // What a deployment with no PUBLIC_BASE_URL answers: trying again where they are gets the
      // admin nowhere, so it is the server's account in a toast rather than the message in place.
      const refusal = createAdminWriteError(ADMIN_WRITE_ERROR_CODES.originUnset)
      const admin = await render()
      admin.beginAdminPasskeyEnrolment.mockRejectedValue(refusal)
      await type('Phone')

      await click(button('Add passkey'))

      expect(addToast).toHaveBeenCalledWith({
        title: 'Couldn’t enrol the passkey',
        description: refusal.message,
        variant: 'error',
      })
      expect(alerts()).toEqual([])
      expect(createPasskey).not.toHaveBeenCalled()
    })

    it('toasts that an authenticator is already enrolled', async () => {
      createPasskey.mockRejectedValue(
        new PasskeyCeremonyError('failed', new DOMException('Excluded.', 'InvalidStateError')))
      await render([ALICES])
      await type('Phone')

      await click(button('Add passkey'))

      expect(addToast).toHaveBeenCalledWith({
        title: 'Couldn’t enrol the passkey',
        description: 'This authenticator is already enrolled.',
        variant: 'error',
      })
    })

    it('toasts the browser\'s account of a ceremony that failed any other way', async () => {
      createPasskey.mockRejectedValue(new PasskeyCeremonyError(
        'failed', new DOMException('The relying party is not this site.', 'SecurityError')))
      const admin = await render([ALICES])
      await type('Phone')

      await click(button('Add passkey'))

      expect(addToast).toHaveBeenCalledWith({
        title: 'Couldn’t enrol the passkey',
        description: 'The relying party is not this site.',
        variant: 'error',
      })
      expect(alerts()).toEqual([])
      expect(admin.addAdminPasskey).not.toHaveBeenCalled()
    })

    it('asks before removing, then removes that passkey on the confirmation of another', async () => {
      const admin = await render([ALICES, ALICES_PHONE, BOBS])

      await click(button('Remove passkey Phone'))

      expect(dialog()?.textContent).toContain('Remove passkey “Phone”?')
      expect(dialog()?.textContent).toContain(
        'The removal is confirmed with one of your passkeys, which may be this one.')
      expect(admin.beginAdminPasskeyRemoval).not.toHaveBeenCalled()

      await click(button('Remove'))

      // ASSERTION is the laptop's: the passkey removed is the one asked about, whichever confirms.
      expect(admin.beginAdminPasskeyRemoval).toHaveBeenCalledWith('alices-phone')
      expect(assertPasskey).toHaveBeenCalledWith(REMOVAL_CHALLENGE)
      expect(admin.removeAdminPasskey).toHaveBeenCalledWith('alices-phone', ASSERTION)
      expect(calledInOrder(admin.beginAdminPasskeyRemoval, assertPasskey, admin.removeAdminPasskey,
        admin.listAdminPasskeys)).toBe(true)
      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(2)
      expect(rows().map(([name]) => name)).toEqual(['Work laptop', 'Security key'])
      expect(dialog()).toBeNull()
    })

    it('removes nothing when the dialog is cancelled', async () => {
      const admin = await render([ALICES])
      await click(button('Remove passkey Work laptop'))

      await click(button('Cancel'))

      expect(dialog()).toBeNull()
      expect(admin.beginAdminPasskeyRemoval).not.toHaveBeenCalled()
      expect(assertPasskey).not.toHaveBeenCalled()
      expect(admin.removeAdminPasskey).not.toHaveBeenCalled()
      expect(rows().map(([name]) => name)).toEqual(['Work laptop'])
    })

    it('keeps the dialog, and the passkey, when the ceremony is cancelled', async () => {
      assertPasskey.mockRejectedValue(new PasskeyCeremonyError('cancelled'))
      const admin = await render([ALICES])
      await click(button('Remove passkey Work laptop'))

      await click(button('Remove'))

      expect(admin.removeAdminPasskey).not.toHaveBeenCalled()
      expect(dialog()?.textContent).toContain('Remove passkey “Work laptop”?')
      expect(button('Remove').disabled).toBe(false)
      expect(addToast).not.toHaveBeenCalled()
      expect(alerts()).toEqual([])
    })

    it('gives the dialog\'s Remove button its focus back when the ceremony is cancelled', async () => {
      const ceremony = deferred<AdminPasskeyAssertion>()
      assertPasskey.mockReturnValue(ceremony.promise)
      await render([ALICES])
      await click(button('Remove passkey Work laptop'))
      await dialogTakesFocus()
      const confirm = button('Remove')

      await focus(confirm)
      await click(confirm)
      await dropFocus()
      expect(confirm.disabled).toBe(true)
      expect(document.activeElement).toBe(document.body)

      await act(async () => ceremony.reject(new PasskeyCeremonyError('cancelled')))

      expect(document.activeElement).toBe(confirm)
    })

    it('says in the dialog that the server did not accept the confirmation', async () => {
      const admin = await render([ALICES])
      admin.removeAdminPasskey.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.passkeyRefused))
      await click(button('Remove passkey Work laptop'))

      await click(button('Remove'))

      // The message is the dialog's alone: the add form shows none of it, during or after.
      expect(dialog()?.querySelector('[role="alert"]')?.textContent)
        .toBe('The passkey confirmation was not accepted. Try again.')
      expect(alerts()).toEqual(['The passkey confirmation was not accepted. Try again.'])
      expect(addToast).not.toHaveBeenCalled()

      await click(button('Cancel'))
      expect(alerts()).toEqual([])

      // Opened again, the dialog asks without the message.
      await click(button('Remove passkey Work laptop'))
      expect(dialog()?.textContent).toContain('Remove passkey “Work laptop”?')
      expect(alerts()).toEqual([])
    })

    it('toasts any other refusal of a removal and closes the dialog', async () => {
      const admin = await render([ALICES])
      admin.beginAdminPasskeyRemoval.mockRejectedValue(new Error('No such passkey of yours.'))
      await click(button('Remove passkey Work laptop'))

      await click(button('Remove'))

      expect(addToast).toHaveBeenCalledWith({
        title: 'Couldn’t remove the passkey',
        description: 'No such passkey of yours.',
        variant: 'error',
      })
      expect(assertPasskey).not.toHaveBeenCalled()
      expect(dialog()).toBeNull()
    })

    it('says so when the passkeys cannot be listed, and still offers to enrol one', async () => {
      const failure = new Error('unavailable')
      const admin = fakeAdmin()
      admin.listAdminPasskeys.mockRejectedValue(failure)

      await renderWith(admin)

      expect(alerts()).toEqual(['Couldn’t load the passkeys.'])
      expect(console.error).toHaveBeenCalledWith('Failed to list the admin passkeys:', failure)
      expect(nameInput()).toBeDefined()
    })

    it('keeps the rows of the latest listing when an earlier one answers after it', async () => {
      const first = deferred<AdminPasskey[]>()
      const admin = fakeAdmin()
      admin.listAdminPasskeys.mockReturnValueOnce(first.promise)
      await renderWith(admin)
      await type('Phone')

      await click(button('Add passkey'))
      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(2)
      expect(rows().map(([name]) => name)).toEqual(['Phone'])

      await act(async () => first.resolve([]))

      expect(rows().map(([name]) => name)).toEqual(['Phone'])
    })

    it('does not report a listing that fails once the card is gone', async () => {
      const listing = deferred<AdminPasskey[]>()
      const admin = fakeAdmin()
      admin.listAdminPasskeys.mockReturnValue(listing.promise)
      await renderWith(admin)

      act(() => root.unmount())
      await act(async () => listing.reject(new Error('unavailable')))

      expect(console.error).not.toHaveBeenCalledWith('Failed to list the admin passkeys:', expect.anything())
    })
  })

  describe('while writes are off', () => {
    it('renders nothing while the passkeys are being listed', async () => {
      const admin = fakeAdmin([ALICES])
      admin.listAdminPasskeys.mockReturnValue(new Promise(() => {}))

      await renderWith(admin, { writesOn: false })

      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(1)
      expect(container.innerHTML).toBe('')
    })

    it('renders nothing when the passkeys cannot be listed', async () => {
      const admin = fakeAdmin([ALICES])
      admin.listAdminPasskeys.mockRejectedValue(new Error('unavailable'))

      await renderWith(admin, { writesOn: false })

      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(1)
      expect(container.innerHTML).toBe('')
    })

    it('renders nothing when no passkey is enrolled', async () => {
      const admin = await render([], { writesOn: false })

      expect(admin.listAdminPasskeys).toHaveBeenCalledTimes(1)
      expect(container.innerHTML).toBe('')
    })

    it('lists the caller\'s passkey, says it approves nothing, and still removes it', async () => {
      const admin = await render([ALICES], { writesOn: false })

      expect(rows().map(([name, owner]) => [name, owner])).toEqual([['Work laptop', 'alice']])
      expect(container.textContent).toContain(
        'Writes to workspaces are off on this deployment, so these passkeys approve nothing. '
        + 'You can still remove your own.')
      expect(nameInput()).toBeUndefined()
      expect(findButton('Add passkey')).toBeUndefined()

      await click(button('Remove passkey Work laptop'))
      await click(button('Remove'))

      expect(admin.beginAdminPasskeyRemoval).toHaveBeenCalledWith('alices-laptop')
      expect(assertPasskey).toHaveBeenCalledWith(REMOVAL_CHALLENGE)
      expect(admin.removeAdminPasskey).toHaveBeenCalledWith('alices-laptop', ASSERTION)
      expect(container.innerHTML).toBe('')
    })

    it('lists another admin\'s passkey with nothing to remove it by', async () => {
      await render([BOBS], { writesOn: false })

      expect(rows().map(([name, owner]) => [name, owner])).toEqual([['Security key', 'bob']])
      expect(findButton('Remove passkey Security key')).toBeUndefined()
      expect(nameInput()).toBeUndefined()
    })
  })
})
