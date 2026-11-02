// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewSpaceDialog } from './NewSpaceDialog'
import {
  ME,
  alerts,
  button,
  click,
  describedBy,
  fakeApi,
  fakeSpace,
  labeledInput,
  member,
  mount,
  person,
  teamSpace,
  type,
  unmountAll,
} from './spacesTestUtils'

type CreateSpace = (key: string, name: string) => Promise<Disposable>

const KEY_RULE = '2 to 32 lowercase letters, digits or dashes, starting with a letter or digit.'
const ADA = person('ada@example.com', 'Ada')
const TAKEN = 'A space with the key “platform” already exists. Choose another key.'

const taken = async (): Promise<never> => { throw new Error('A space with this key already exists.') }

// A `createSpace` whose connection drops under the first attempt, and which refuses the key as
// taken on the next.
const unansweredThenTaken = () => vi.fn<CreateSpace>(taken)
  .mockRejectedValueOnce(new Error('Peer closed WebSocket'))

// Names the space 'Platform', asks for it, and asks again when told to.
const createTwice = async () => {
  await type(labeledInput('Name'), 'Platform')
  await click(button('Create'))
  expect(alerts()).toEqual(['Couldn’t create the space. Try again.'])
  await click(button('Create'))
}

const render = async (createSpace: CreateSpace, openSpace?: (key: string) => unknown) => {
  const onCreated = vi.fn<(key: string) => void>()
  await mount(
    <NewSpaceDialog onClose={() => {}} onCreated={onCreated} />,
    fakeApi({ createSpace, openSpace }),
  )
  return { onCreated }
}

describe('NewSpaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('derives the key from the name until the key is edited', async () => {
    await render(async () => ({ [Symbol.dispose]() {} }))
    expect(describedBy(labeledInput('Key'))).toContain(KEY_RULE)
    expect(button('Create').disabled).toBe(true)

    await type(labeledInput('Name'), 'Platform Team')
    expect(labeledInput('Key').value).toBe('platform-team')
    expect(button('Create').disabled).toBe(false)

    await type(labeledInput('Key'), 'platform')
    await type(labeledInput('Name'), 'Platform Engineering')
    expect(labeledInput('Key').value).toBe('platform')
  })

  it('explains the key grammar and creates nothing while the key breaks it', async () => {
    const createSpace = vi.fn<CreateSpace>(async () => ({ [Symbol.dispose]() {} }))
    await render(createSpace)
    await type(labeledInput('Name'), 'Platform')

    await type(labeledInput('Key'), '-platform')
    expect(describedBy(labeledInput('Key'))).toBe(`Use ${KEY_RULE}`)
    expect(labeledInput('Key').getAttribute('aria-invalid')).toBe('true')
    expect(button('Create').disabled).toBe(true)

    // Enter in a field submits the form whatever the button's state.
    await click(button('Create'))
    labeledInput('Key').form!.requestSubmit()
    expect(createSpace).not.toHaveBeenCalled()

    // An emptied key does not go back to following the name, and says why nothing can be created.
    await type(labeledInput('Key'), '')
    expect(labeledInput('Key').value).toBe('')
    expect(describedBy(labeledInput('Key'))).toBe(`Use ${KEY_RULE}`)
    expect(labeledInput('Key').getAttribute('aria-invalid')).toBe('true')
    expect(button('Create').disabled).toBe(true)
  })

  it('lowers a capital typed into the key and leaves the caret where it was', async () => {
    await render(async () => ({ [Symbol.dispose]() {} }))
    await type(labeledInput('Key'), 'platform')

    // A capital typed after the fourth character.
    const key = labeledInput('Key')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'platXform')
      key.setSelectionRange(5, 5)
      key.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(key.value).toBe('platxform')
    expect([key.selectionStart, key.selectionEnd]).toEqual([5, 5])
  })

  it('creates the space under the trimmed name, releases it and reports its key', async () => {
    const dispose = vi.fn<() => void>()
    const createSpace = vi.fn<CreateSpace>(async () => ({ [Symbol.dispose]: dispose }))
    const { onCreated } = await render(createSpace)

    await type(labeledInput('Name'), '  Platform Team ')
    await click(button('Create'))

    expect(createSpace).toHaveBeenCalledExactlyOnceWith('platform-team', 'Platform Team')
    expect(dispose).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('platform-team')
  })

  it('shows a taken key against the key field until the key changes', async () => {
    const openSpace = vi.fn<(key: string) => unknown>()
    const { onCreated } = await render(vi.fn<CreateSpace>(taken), openSpace)

    await type(labeledInput('Name'), 'Platform')
    await click(button('Create'))

    expect(describedBy(labeledInput('Key'))).toBe(TAKEN)
    expect(labeledInput('Key').getAttribute('aria-invalid')).toBe('true')
    expect(button('Create').disabled).toBe(true)
    expect(onCreated).not.toHaveBeenCalled()
    // A key refused on the first try is nobody's lost creation, so no space is asked about it.
    expect(openSpace).not.toHaveBeenCalled()

    await type(labeledInput('Key'), 'platform-eng')
    expect(describedBy(labeledInput('Key'))).toContain('Identifies the space')
    expect(button('Create').disabled).toBe(false)
  })

  it('moves focus to the refused key, whose description is the refusal', async () => {
    await render(taken)
    await type(labeledInput('Name'), 'Platform')
    button('Create').focus()

    await click(button('Create'))

    // The button that had focus is disabled now, and the refusal describes another field.
    expect(document.activeElement).toBe(labeledInput('Key'))
    expect(alerts()).toEqual([])
  })

  it('says the refusal when the key field already has focus, until the form is edited', async () => {
    await render(taken)
    await type(labeledInput('Name'), 'Platform')
    const key = labeledInput('Key')
    key.focus()

    // Enter in the key field.
    await act(async () => key.form!.requestSubmit())

    expect(document.activeElement).toBe(key)
    expect(alerts()).toEqual([TAKEN])

    await type(key, 'platform-eng')
    expect(alerts()).toEqual([])
  })

  describe('after an attempt that ended with no answer', () => {
    it('reports the space as created when the refused key is the user’s own, under the name it was given', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      const space = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')])
      const openSpace = vi.fn<(key: string) => unknown>(() => space.stub)
      const { onCreated } = await render(unansweredThenTaken(), openSpace)

      await createTwice()

      expect(openSpace).toHaveBeenCalledExactlyOnceWith('platform')
      expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('platform')
      expect(alerts()).toEqual([])
    })

    it.each([
      ['a space the user is not a member of', () => fakeSpace(teamSpace('platform', 'Platform'), [])],
      ['a space of that name the user visits, because it lists a published workspace',
        () => fakeSpace(teamSpace('platform', 'Platform'), [], [
          { id: 'w-brief', title: 'Brief', owner: ADA, created: new Date('2026-01-01'), published: 'use' },
        ])],
      ['a space of that name the user is a member but not an admin of',
        () => fakeSpace(teamSpace('platform', 'Platform'), [member(ADA, 'admin'), member(ME, 'build')])],
      ['a space of another name the user is a member of',
        () => fakeSpace(teamSpace('platform', 'Platform engineering'), [member(ME, 'use')])],
    ])('shows the key as taken when it is %s', async (_whose, existing) => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      const space = existing()
      const { onCreated } = await render(unansweredThenTaken(), () => space.stub)

      await createTwice()

      expect(describedBy(labeledInput('Key'))).toBe(TAKEN)
      expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
      expect(onCreated).not.toHaveBeenCalled()
    })
  })

  it('shows any other refusal in the server’s words and stays open for another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const createSpace = vi.fn<CreateSpace>(async () => {
      throw new Error('A space name is 1 to 100 characters.')
    })
    const { onCreated } = await render(createSpace)

    await type(labeledInput('Name'), 'Platform')
    await click(button('Create'))

    expect(alerts()).toEqual(['A space name is 1 to 100 characters.'])
    expect(onCreated).not.toHaveBeenCalled()
    expect(button('Create').disabled).toBe(false)
  })
})
