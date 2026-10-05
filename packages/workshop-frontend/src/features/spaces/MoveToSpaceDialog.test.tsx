// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, SpaceInfo } from '@gadgets/workshop-shared/api'
import { hasMoveTarget, MoveToSpaceDialog } from './MoveToSpaceDialog'
import {
  ME,
  alerts,
  button,
  click,
  fakeApi,
  mount,
  person,
  personalSpace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

const SPACES = [
  personalSpace(ME, 'admin'),
  // Someone else's personal space the user is a member of: only its owner adds workspaces to it.
  personalSpace(person('ada@example.com', 'Ada'), 'build'),
  teamSpace('design', 'Design', 'use'),
  teamSpace('platform', 'Platform'),
]

const render = async (
  spaceKey: string | undefined,
  moveToSpace: Overseer['moveToSpace'] = async () => {},
  spaces: SpaceInfo[] = SPACES,
) => {
  const overseer = {
    moveToSpace: vi.fn<Overseer['moveToSpace']>(moveToSpace),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const openGadget = vi.fn<(id: string) => unknown>(() => overseer)
  const onMoved = vi.fn<(spaceKey: string | null) => void>()
  const onMoveFailed = vi.fn<() => Promise<void>>(async () => {})
  const dialog = (recordedIn: string | undefined) => (
    <MoveToSpaceDialog
      workspace={{ id: 'w1', title: 'Roadmap', spaceKey: recordedIn }}
      spaces={spaces}
      onClose={() => {}}
      onMoved={onMoved}
      onMoveFailed={onMoveFailed}
    />
  )
  const { rerender } = await mount(dialog(spaceKey), fakeApi({ openGadget }))
  return {
    overseer,
    openGadget,
    onMoved,
    onMoveFailed,
    // The dialog as its caller renders it once the workspace, read again, is recorded in a space.
    readAgain: (recordedIn: string | undefined) => rerender(dialog(recordedIn)),
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
    expect(document.body.textContent).not.toContain('It is now in the space')
  })

  it('names by its key a current space that is not among the user’s spaces', async () => {
    // A workspace stays in a team space after its owner has left it.
    const { overseer } = await render('left-team')

    expect(document.body.textContent)
      .toContain('It is now in the space “left-team”, which is not in your list of spaces.')
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
      'It is now in the space “design”. Your list of spaces has not loaded, so only your personal space is offered.')
    expect(document.body.textContent).not.toContain('not in your list of spaces')
    expect(targets()).toEqual([{ name: 'Personal', checked: false }])
  })

  it('moves the workspace to the chosen team space and releases it', async () => {
    const { overseer, openGadget, onMoved } = await render(undefined)
    expect(targets()[0]).toEqual({ name: 'Personal (current)', checked: true })

    await choose('Platform')
    await click(button('Move'))

    expect(openGadget).toHaveBeenCalledExactlyOnceWith('w1')
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('platform')
    expect(overseer[Symbol.dispose]).toHaveBeenCalledOnce()
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
  const [OWN, ADAS, DESIGN] = SPACES

  it('finds none for a workspace in the personal space of a user with no team space', () => {
    expect(hasMoveTarget({}, [OWN, ADAS])).toBe(false)
    expect(hasMoveTarget({}, [])).toBe(false)
  })

  it('finds a team space, and for a workspace in a team space the personal one', () => {
    expect(hasMoveTarget({}, [OWN, DESIGN])).toBe(true)
    // A workspace stays in a team space its owner has left.
    expect(hasMoveTarget({ spaceKey: 'left-team' }, [OWN])).toBe(true)
  })
})
