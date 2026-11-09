// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, SpaceInfo } from '@gadgets/workshop-shared/api'
import { hasMoveTarget, MoveToSpaceDialog } from './MoveToSpaceDialog'
import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  mount,
  personalSpace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

const SPACES = [
  personalSpace(ME),
  teamSpace('design', 'Design', 'use'),
  teamSpace('platform', 'Platform'),
]

const render = async (
  spaceId: string | undefined,
  moveToSpace: Overseer['moveToSpace'] = async () => {},
  spaces: SpaceInfo[] = SPACES,
) => {
  const overseer = {
    moveToSpace: vi.fn<Overseer['moveToSpace']>(moveToSpace),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const openWorkspace = vi.fn<(id: string) => unknown>(() => overseer)
  const onMoved = vi.fn<(spaceId: string | null) => void>()
  const onMoveFailed = vi.fn<() => Promise<void>>(async () => {})
  const dialog = (recordedIn: string | undefined) => (
    <MoveToSpaceDialog
      workspace={{ id: 'w1', title: 'Roadmap', spaceId: recordedIn }}
      spaces={spaces}
      onClose={() => {}}
      onMoved={onMoved}
      onMoveFailed={onMoveFailed}
    />
  )
  const { rerender } = await mount(dialog(spaceId), fakeApi({ openWorkspace }))
  return {
    overseer,
    openWorkspace,
    onMoved,
    onMoveFailed,
    // The dialog as its caller renders it once the workspace, read again, is recorded in a space.
    readAgain: (recordedIn: string | undefined) => rerender(dialog(recordedIn)),
    // The dialog under a session that replaces the one it was opened in, as a reconnect does.
    replaceSession: (api: Parameters<typeof rerender>[1]) => rerender(dialog(spaceId), api),
  }
}

// What a move rejects with when the space could not be reached.
const unreachable = async (): Promise<never> => { throw new Error('Peer closed WebSocket') }

const targets = () => [...document.body.querySelectorAll('label')]
  .filter(label => label.querySelector('[role="radio"]'))
  .map(label => ({
    name: label.textContent,
    checked: label.querySelector('[role="radio"]')!.getAttribute('aria-checked') === 'true',
  }))

// The target's label, which is what a pointer lands on. jsdom has no PointerEvent, which the
// radio itself forwards its clicks with.
const choose = (name: string) =>
  click([...document.body.querySelectorAll('label')].find(label => label.textContent === name)!)

describe('MoveToSpaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('offers the personal space and the user’s team spaces, with the current one marked', async () => {
    await render('design')

    expect(targets()).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Design (current)', checked: true },
      { name: 'Platform', checked: false },
    ])
    expect(button('Move').disabled).toBe(true)
    expect(document.body.textContent).not.toContain('It is now in')
  })

  it('says that the current space is not in the user’s list, without naming it', async () => {
    // A workspace stays in a team space after its owner has left it.
    const { overseer } = await render('left-team')

    expect(document.body.textContent)
      .toContain('It is now in a space that is not in your list of spaces.')
    expect(document.body.textContent).not.toContain('left-team')
    expect(targets()).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Design', checked: false },
      { name: 'Platform', checked: false },
    ])
    expect(button('Move').disabled).toBe(true)

    await choose('Personal')
    await click(button('Move'))
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('does not say of a list of spaces that has not loaded that the current space is missing from it', async () => {
    // What `useSpaces` reports until its first load, and after one that failed.
    await render('design', undefined, [])

    expect(document.body.textContent).toContain(
      'It is now in a team space. Your list of spaces has not loaded, so only your personal space is offered.')
    expect(document.body.textContent).not.toContain('design')
    expect(document.body.textContent).not.toContain('not in your list of spaces')
    expect(targets()).toEqual([{ name: 'Personal', checked: false }])
  })

  it('moves the workspace to the chosen team space and releases it', async () => {
    const { overseer, openWorkspace, onMoved } = await render(undefined)
    expect(targets()[0]).toEqual({ name: 'Personal (current)', checked: true })

    await choose('Platform')
    await click(button('Move'))

    expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('w1')
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(overseer[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(onMoved).toHaveBeenCalledExactlyOnceWith('platform')
  })

  it('leaves Move enabled and marked busy while the move is in flight, and moves nothing more on a second press', async () => {
    const move = deferred<void>()
    const { overseer, onMoved } = await render(undefined, () => move.promise)

    await choose('Platform')
    await click(button('Move'))
    const busy = button('Moving…')
    expect(busy.disabled).toBe(false)
    expect(busy.getAttribute('aria-disabled')).toBe('true')
    // The spinner.
    expect(busy.querySelector('[role="status"]')).not.toBeNull()

    await click(busy)
    expect(overseer.moveToSpace).toHaveBeenCalledOnce()

    await act(async () => move.resolve())
    expect(onMoved).toHaveBeenCalledExactlyOnceWith('platform')
  })

  it('moves nothing under a session that replaces another before its own flags say the flag is on, and keeps Move focusable meanwhile', async () => {
    const { openWorkspace, onMoved, replaceSession } = await render(undefined)
    await choose('Platform')
    const flags = deferred<{ spaces: boolean }>()
    const overseer = {
      moveToSpace: vi.fn<Overseer['moveToSpace']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
    const reopened = vi.fn<(id: string) => unknown>(() => overseer)
    await replaceSession(fakeApi({ getUiFeatureFlags: () => flags.promise, openWorkspace: reopened }))

    const waiting = button('Move')
    expect(waiting.disabled).toBe(false)
    expect(waiting.getAttribute('aria-disabled')).toBe('true')
    await click(waiting)
    expect(reopened).not.toHaveBeenCalled()
    expect(openWorkspace).not.toHaveBeenCalled()

    await act(async () => flags.resolve({ spaces: true }))
    expect(button('Move').getAttribute('aria-disabled')).toBeNull()
    await click(button('Move'))
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(onMoved).toHaveBeenCalledExactlyOnceWith('platform')
  })

  it('returns the workspace to the personal space with null', async () => {
    const { overseer, onMoved } = await render('platform')

    await choose('Personal')
    await click(button('Move'))

    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith(null)
    expect(onMoved).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('shows a refused move and stays open, with the workspace released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { overseer, onMoved, onMoveFailed } = await render(undefined, async () => {
      throw new Error('No such space, or you are not a member of it.')
    })

    await choose('Design')
    await click(button('Move'))

    expect(alerts()).toEqual(['No such space, or you are not a member of it.'])
    expect(onMoved).not.toHaveBeenCalled()
    expect(onMoveFailed).toHaveBeenCalledOnce()
    expect(overseer[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
    expect(targets()[0]).toEqual({ name: 'Personal (current)', checked: false })
    expect(button('Move').disabled).toBe(false)
  })

  it('marks the space a move that failed with no answer left the workspace recorded in, and takes the move again', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { overseer, onMoved, onMoveFailed, readAgain } = await render(undefined)
    overseer.moveToSpace.mockImplementationOnce(unreachable)

    await choose('Design')
    await click(button('Move'))
    expect(onMoveFailed).toHaveBeenCalledOnce()
    // The workspace's record was pointed at the space before the space could not be reached.
    await readAgain('design')

    expect(alerts()).toEqual(['Couldn’t move the workspace. Try again.'])
    expect(targets().slice(0, 2)).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Design (current)', checked: true },
    ])
    expect(onMoved).not.toHaveBeenCalled()

    // Asking again is what completes the move.
    await click(button('Move'))
    expect(overseer.moveToSpace.mock.calls).toEqual([['design'], ['design']])
    expect(onMoved).toHaveBeenCalledExactlyOnceWith('design')
  })

  it('leaves Move enabled while it asks again for the space a failed move left the workspace recorded in', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const again = deferred<void>()
    const { overseer, onMoved, readAgain } = await render(undefined)
    overseer.moveToSpace.mockImplementationOnce(unreachable).mockImplementationOnce(() => again.promise)
    await choose('Design')
    await click(button('Move'))
    await readAgain('design')

    await click(button('Move'))
    expect(button('Moving…').disabled).toBe(false)

    await act(async () => again.resolve())
    expect(onMoved).toHaveBeenCalledExactlyOnceWith('design')
  })

  it('lets the workspace be returned from the space a failed move left it recorded in', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { overseer, onMoved, readAgain } = await render(undefined)
    overseer.moveToSpace.mockImplementationOnce(unreachable)
    await choose('Design')
    await click(button('Move'))
    await readAgain('design')

    await choose('Personal')
    expect(alerts()).toEqual([])
    await click(button('Move'))

    expect(overseer.moveToSpace).toHaveBeenLastCalledWith(null)
    expect(onMoved).toHaveBeenCalledExactlyOnceWith(null)
  })
})

describe('hasMoveTarget', () => {
  const [OWN, DESIGN] = SPACES

  it('finds none for a workspace in the personal space of a user with no team space', () => {
    expect(hasMoveTarget({}, [OWN])).toBe(false)
    expect(hasMoveTarget({}, [])).toBe(false)
  })

  it('finds a team space, and for a workspace in a team space the personal one', () => {
    expect(hasMoveTarget({}, [OWN, DESIGN])).toBe(true)
    // A workspace stays in a team space its owner has left.
    expect(hasMoveTarget({ spaceId: 'left-team' }, [OWN])).toBe(true)
  })
})
