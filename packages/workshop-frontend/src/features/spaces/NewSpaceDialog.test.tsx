// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { NewSpaceDialog } from './NewSpaceDialog'
import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  labeledInput,
  member,
  mount,
  personalSpace,
  pressEscape,
  settle,
  teamSpace,
  type,
  unmountAll,
} from './spacesTestUtils'
import type { Spaces } from './useSpaces'

// The space a creation answers with: the dialog reads its info on the call itself, so the fake
// answers with the space and not with a promise of it.
const created = (name: string, id = 'space-1') => fakeSpace(teamSpace(id, name), [member(ME, 'admin')])

// A creation the server refuses: the read pipelined on it rejects with the refusal.
const refused = () => {
  const space = created('Platform')
  space.getInfo.mockRejectedValue(new Error('A space name is 1 to 100 characters.'))
  return space
}

// A creation that ends with no answer, as when the connection is lost: it may have made the space.
const unanswered = () => {
  const space = created('Platform')
  space.getInfo.mockRejectedValue(new Error('Peer closed WebSocket'))
  return space
}

const NO_ANSWER = 'Couldn’t create the space. Try again.'

const render = async (
  createSpace: (name: string) => unknown,
  { spaces = {}, strict = false }: { spaces?: Partial<Spaces>; strict?: boolean } = {},
) => {
  const onCreated = vi.fn<(id: string) => void>()
  const onClose = vi.fn<() => void>()
  const refresh = vi.fn<() => Promise<void>>(async () => {})
  // What the dialog reads when it looks for a space: the tests that expect a look give it one.
  const listSpaces = vi.fn<() => Promise<SpaceInfo[]>>(async () => [personalSpace(ME)])
  const dialog = (overrides: Partial<Spaces>) => {
    const ui = (
      <NewSpaceDialog
        spaces={{ enabled: true, spaces: [personalSpace(ME)], loading: false, failed: false, refresh, ...overrides }}
        onClose={onClose}
        onCreated={onCreated}
      />
    )
    return strict ? <StrictMode>{ui}</StrictMode> : ui
  }
  // A development build runs the effects of what mounts under `StrictMode` twice only when what
  // is around it was mounted before, as the page is before its dialog opens.
  const { rerender, unmount } = await mount(strict ? null : dialog(spaces), fakeApi({ createSpace, listSpaces }))
  if (strict) await rerender(dialog(spaces))
  return {
    onCreated,
    onClose,
    refresh,
    listSpaces,
    // The dialog as its caller renders it once the list of spaces has changed.
    rerender: (overrides: Partial<Spaces>) => rerender(dialog(overrides)),
    // The dialog under a session that replaces the one it was opened in, as a reconnect does.
    replaceSession: (api: Parameters<typeof rerender>[1]) => rerender(dialog({}), api),
    unmount,
  }
}

const create = async (name: string) => {
  await type(labeledInput('Name'), name)
  await click(button('Create'))
}

// A creation with no answer is logged quietly, and a refusal loudly.
const quiet = () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
}

// A creation in flight when the page, and the dialog with it, is left.
const leaveWhileCreating = async () => {
  const space = created('Platform')
  let answer!: { resolve: (info: SpaceInfo) => void; reject: (err: Error) => void }
  space.getInfo.mockReturnValue(new Promise<SpaceInfo>((resolve, reject) => { answer = { resolve, reject } }))
  const dialog = await render(() => space)
  await create('Platform')
  await dialog.unmount()
  return { ...dialog, answer }
}

// A session that replaces the dialog's own: it answers its flags when the test says, and counts
// what it is asked.
const replacement = (space = created('Field notes', 'space-2')) => {
  const flags = deferred<{ spaces: boolean }>()
  const createSpace = vi.fn<(name: string) => unknown>(() => space)
  const listSpaces = vi.fn<() => Promise<SpaceInfo[]>>(async () => [personalSpace(ME)])
  return {
    api: fakeApi({ getUiFeatureFlags: () => flags.promise, createSpace, listSpaces }),
    createSpace,
    listSpaces,
    answerFlags: (spaces: boolean) => act(async () => flags.resolve({ spaces })),
  }
}

describe('NewSpaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('has no field but the name', async () => {
    await render(() => created('Platform'))

    expect([...document.body.querySelectorAll('input, textarea, select')]).toEqual([labeledInput('Name')])
  })

  it('creates the space under the trimmed name, releases it and reports its id', async () => {
    const space = created('Platform Team')
    const createSpace = vi.fn<(name: string) => unknown>(() => space)
    const { onCreated } = await render(createSpace)

    await type(labeledInput('Name'), '  Platform Team ')
    await click(button('Create'))

    expect(createSpace).toHaveBeenCalledExactlyOnceWith('Platform Team')
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-1')
  })

  it('creates nothing for a name that is blank once trimmed', async () => {
    const createSpace = vi.fn<(name: string) => unknown>(() => created(''))
    const { onCreated } = await render(createSpace)

    await type(labeledInput('Name'), '   ')
    expect(button('Create').disabled).toBe(true)

    // Enter in the field submits the form whatever the button's state.
    await act(async () => labeledInput('Name').form!.requestSubmit())
    expect(createSpace).not.toHaveBeenCalled()
    expect(onCreated).not.toHaveBeenCalled()
  })

  it('shows what the server refuses and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = refused()
    const createSpace = vi.fn<(name: string) => unknown>(refused).mockReturnValueOnce(first)
    const { onCreated } = await render(createSpace)

    await type(labeledInput('Name'), 'Platform')
    await click(button('Create'))

    expect(alerts()).toEqual(['A space name is 1 to 100 characters.'])
    expect(onCreated).not.toHaveBeenCalled()
    expect(first[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(button('Create').disabled).toBe(false)

    await click(button('Create'))
    expect(createSpace).toHaveBeenCalledTimes(2)
  })

  it('stops showing what the server refused once the next creation is asked for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const next = created('Platform')
    next.getInfo.mockReturnValue(deferred<SpaceInfo>().promise)
    await render(vi.fn<(name: string) => unknown>(() => next).mockReturnValueOnce(refused()))

    await create('Platform')
    expect(alerts()).toEqual(['A space name is 1 to 100 characters.'])

    await click(button('Create'))
    expect(button('Creating…').getAttribute('aria-disabled')).toBe('true')
    expect(alerts()).toEqual([])
  })

  it('asks for no list of spaces to open, or to create', async () => {
    const { onCreated, listSpaces, refresh } = await render(() => created('Platform'))

    await create('Platform')

    expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-1')
    expect(listSpaces).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  describe('after a creation that got no answer', () => {
    it('finds the space that creation made, and makes no second one', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const { onCreated, listSpaces } = await render(createSpace)

      await create('Platform')
      expect(alerts()).toEqual([NO_ANSWER])
      expect(onCreated).not.toHaveBeenCalled()

      listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('made', 'Platform')])
      await click(button('Create'))

      expect(createSpace).toHaveBeenCalledOnce()
      expect(listSpaces).toHaveBeenCalledOnce()
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('made')
    })

    it('creates again when the lost creation left no space', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(() => created('Platform', 'space-2'))
        .mockReturnValueOnce(unanswered())
      const { onCreated, listSpaces } = await render(createSpace)

      await create('Platform')
      await click(button('Create'))

      expect(listSpaces).toHaveBeenCalledOnce()
      expect(createSpace).toHaveBeenCalledTimes(2)
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-2')
    })

    it('does not take an older space of the same name, or one it does not administer, for the lost one', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(() => created('Platform', 'space-2'))
        .mockReturnValueOnce(unanswered())
      const older = teamSpace('old', 'Platform')
      const { onCreated, listSpaces } = await render(createSpace, {
        spaces: { spaces: [personalSpace(ME), older] },
      })
      listSpaces.mockResolvedValue([
        personalSpace(ME),
        older,
        teamSpace('theirs', 'Platform', 'use'),
        teamSpace('other', 'Design'),
      ])

      await create('Platform')
      await click(button('Create'))

      expect(listSpaces).toHaveBeenCalledOnce()
      expect(createSpace).toHaveBeenCalledTimes(2)
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-2')
    })

    it('creates under another name without looking', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(() => created('Design', 'space-2'))
        .mockReturnValueOnce(unanswered())
      const { onCreated, listSpaces } = await render(createSpace)
      listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('made', 'Platform')])

      await create('Platform')
      await create('Design')

      expect(createSpace).toHaveBeenLastCalledWith('Design')
      expect(listSpaces).not.toHaveBeenCalled()
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-2')
    })

    it('looks for the space of the latest such creation once the name has changed', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const { onCreated, listSpaces } = await render(createSpace)

      await create('Platform')
      await create('Design')
      listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('made', 'Design')])
      await click(button('Create'))

      expect(createSpace).toHaveBeenCalledTimes(2)
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('made')
    })

    it('finds a space the first of two such creations made, though the list came to show it in between', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const first = teamSpace('first', 'Platform')
      const { onCreated, listSpaces, rerender } = await render(createSpace)

      await create('Platform')
      // The list is read again elsewhere, and has the space the first creation made.
      await rerender({ spaces: [personalSpace(ME), first] })
      // The look-up of the second attempt misses it, and that attempt gets no answer either.
      listSpaces.mockResolvedValueOnce([personalSpace(ME)])
      await click(button('Create'))
      expect(createSpace).toHaveBeenCalledTimes(2)

      listSpaces.mockResolvedValue([personalSpace(ME), first])
      await click(button('Create'))

      expect(createSpace).toHaveBeenCalledTimes(2)
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('first')
    })

    it('reads the list of spaces again when it closes', async () => {
      quiet()
      const { onClose, refresh } = await render(unanswered)

      await create('Platform')
      expect(refresh).not.toHaveBeenCalled()
      await click(button('Cancel'))

      expect(refresh).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
      expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0])
    })

    it.each<[string, Partial<Spaces>]>([
      ['was still loading', { spaces: [], loading: true }],
      ['could not be read', { spaces: [], failed: true }],
    ])('reads the list of spaces again when it closes, though that list %s when the space was asked for', async (_state, spaces) => {
      quiet()
      const { onClose, refresh } = await render(unanswered, { spaces })

      await create('Platform')
      expect(refresh).not.toHaveBeenCalled()
      await click(button('Cancel'))

      expect(refresh).toHaveBeenCalledOnce()
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('stays open and creates nothing when the list cannot be read for the look-up', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const { onCreated, onClose, listSpaces } = await render(createSpace)

      await create('Platform')
      listSpaces.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
      await click(button('Create'))

      expect(alerts()).toEqual([NO_ANSWER])
      expect(createSpace).toHaveBeenCalledOnce()
      expect(onCreated).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()

      // The attempt is still the one looked for.
      listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('made', 'Platform')])
      await click(button('Create'))
      expect(createSpace).toHaveBeenCalledOnce()
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('made')
    })

    it('shows what the server refuses the look-up with', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const { listSpaces } = await render(createSpace)

      await create('Platform')
      listSpaces.mockRejectedValueOnce(new Error('Your spaces cannot be listed right now.'))
      await click(button('Create'))

      expect(alerts()).toEqual(['Your spaces cannot be listed right now.'])
      expect(createSpace).toHaveBeenCalledOnce()
    })

    it('stays open and busy while it looks for the space, and looks once', async () => {
      quiet()
      const createSpace = vi.fn<(name: string) => unknown>(unanswered)
      const { onCreated, onClose, listSpaces } = await render(createSpace)
      const look = deferred<SpaceInfo[]>()
      listSpaces.mockReturnValue(look.promise)

      await create('  Platform ')
      await click(button('Create'))
      const busy = button('Creating…')
      expect(busy.getAttribute('aria-disabled')).toBe('true')

      await click(busy)
      await act(async () => labeledInput('Name').form!.requestSubmit())
      expect(listSpaces).toHaveBeenCalledOnce()
      await pressEscape()
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => look.resolve([personalSpace(ME), teamSpace('made', 'Platform')]))
      expect(createSpace).toHaveBeenCalledExactlyOnceWith('Platform')
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('made')

      // Escape is what closes the dialog once nothing is in flight.
      await pressEscape()
      expect(onClose).toHaveBeenCalledOnce()
    })
  })

  it('looks for no space after a refusal', async () => {
    quiet()
    const createSpace = vi.fn<(name: string) => unknown>(refused)
    const { listSpaces } = await render(createSpace)

    await create('Platform')
    await click(button('Create'))

    expect(createSpace).toHaveBeenCalledTimes(2)
    expect(listSpaces).not.toHaveBeenCalled()
  })

  it('reads nothing again when it closes with no creation that got no answer', async () => {
    quiet()
    const { onClose, refresh } = await render(refused)

    await create('Platform')
    await click(button('Cancel'))

    expect(onClose).toHaveBeenCalledOnce()
    expect(refresh).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<Spaces>]>([
    ['was still loading', { spaces: [], loading: true }],
    ['could not be read', { spaces: [], failed: true }],
  ])('remembers nothing of a creation made while the list of spaces %s', async (_state, spaces) => {
    quiet()
    const createSpace = vi.fn<(name: string) => unknown>(() => created('Platform', 'space-2'))
      .mockReturnValueOnce(unanswered())
    const { onCreated, listSpaces, rerender } = await render(createSpace, { spaces })
    listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('made', 'Platform')])

    await create('Platform')
    await rerender({})
    await click(button('Create'))

    expect(listSpaces).not.toHaveBeenCalled()
    expect(createSpace).toHaveBeenCalledTimes(2)
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-2')
  })

  it('leaves Create enabled and marked busy while the creation is in flight, and creates nothing more on a second press', async () => {
    const space = created('Platform')
    const info = deferred<SpaceInfo>()
    space.getInfo.mockReturnValue(info.promise)
    const createSpace = vi.fn<(name: string) => unknown>(() => space)
    const { onCreated } = await render(createSpace)

    await create('Platform')
    const busy = button('Creating…')
    expect(busy.disabled).toBe(false)
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    // The spinner.
    expect(busy.querySelector('[role="status"]')).not.toBeNull()

    await click(busy)
    await act(async () => labeledInput('Name').form!.requestSubmit())
    expect(createSpace).toHaveBeenCalledOnce()

    await act(async () => info.resolve(teamSpace('space-1', 'Platform')))
    expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-1')
    expect(button('Create').getAttribute('aria-disabled')).toBeNull()
  })

  describe('under a session that replaces the one it was opened in', () => {
    it('creates no space before the session’s own flags say the flag is on, and keeps Create focusable meanwhile', async () => {
      const { onCreated, replaceSession } = await render(() => created('Platform'))
      await type(labeledInput('Name'), 'Field notes')
      const { api, createSpace, answerFlags } = replacement()
      await replaceSession(api)

      const waiting = button('Create')
      expect(waiting.disabled).toBe(false)
      expect(waiting.getAttribute('aria-disabled')).toBe('true')
      await click(waiting)
      await act(async () => labeledInput('Name').form!.requestSubmit())
      await settle()
      expect(createSpace).not.toHaveBeenCalled()
      expect(labeledInput('Name').value).toBe('Field notes')

      await answerFlags(true)
      expect(button('Create').getAttribute('aria-disabled')).toBeNull()
      await click(button('Create'))
      await settle()
      expect(createSpace).toHaveBeenCalledExactlyOnceWith('Field notes')
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-2')
    })

    it('looks for no space a lost creation made before the session’s own flags say the flag is on', async () => {
      quiet()
      const { onCreated, replaceSession } = await render(unanswered)
      await create('Platform')
      expect(alerts()).toEqual([NO_ANSWER])
      const { api, createSpace, listSpaces, answerFlags } = replacement()
      listSpaces.mockResolvedValue([personalSpace(ME), teamSpace('space-1', 'Platform')])
      await replaceSession(api)

      await click(button('Create'))
      await settle()
      expect(listSpaces).not.toHaveBeenCalled()

      await answerFlags(true)
      await click(button('Create'))
      await settle()
      expect(listSpaces).toHaveBeenCalledOnce()
      expect(createSpace).not.toHaveBeenCalled()
      expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-1')
    })
  })

  describe('for an answer that arrives after the dialog has gone', () => {
    it('reports no space, and reads the list of spaces again', async () => {
      const { onCreated, refresh, answer } = await leaveWhileCreating()

      answer.resolve(teamSpace('space-1', 'Platform'))
      await settle()

      expect(onCreated).not.toHaveBeenCalled()
      expect(refresh).toHaveBeenCalledOnce()
    })

    it('reads the list of spaces again when there was no answer, since the space may exist', async () => {
      quiet()
      const { onCreated, refresh, answer } = await leaveWhileCreating()

      answer.reject(new Error('Peer closed WebSocket'))
      await settle()

      expect(onCreated).not.toHaveBeenCalled()
      expect(refresh).toHaveBeenCalledOnce()
    })

    it('reports and reads nothing for a refusal', async () => {
      quiet()
      const { onCreated, refresh, answer } = await leaveWhileCreating()

      answer.reject(new Error('A space name is 1 to 100 characters.'))
      await settle()

      expect(onCreated).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
    })
  })

  it('reports the space it created when its effects are run twice, as a development build runs them', async () => {
    const { onCreated, refresh } = await render(() => created('Platform'), { strict: true })

    await create('Platform')
    await settle()

    expect(onCreated).toHaveBeenCalledExactlyOnceWith('space-1')
    expect(refresh).not.toHaveBeenCalled()
  })
})
