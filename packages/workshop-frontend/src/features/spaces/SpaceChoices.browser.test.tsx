/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo, SubspaceInfo } from '@gadgets/workshop-shared/api'
import { SpaceChoices, type SpaceChoice } from './SpaceChoices'
import {
  ME,
  fakeApi,
  fakeSpace,
  member,
  mount,
  openSpaceAmong,
  personalSpace,
  subspace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import '../../styles.css'

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

const PERSONAL = personalSpace(ME)
const SPACES = [PERSONAL, teamSpace('design', 'Design', 'use'), teamSpace('platform', 'Platform')]

// Platform holds Infra and Ops, and the personal space what `inPersonal` says; nothing else
// holds anything. `setDisabled` is the caller letting nothing be chosen, and choosing again.
const render = async (
  spaces: SpaceInfo[] = SPACES,
  { disabled = false, inPersonal = [] }: { disabled?: boolean; inPersonal?: SubspaceInfo[] } = {},
) => {
  const platform = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')], [], {
    subspaces: [subspace('infra', 'Infra'), subspace('ops', 'Ops')],
  })
  const openSpace = openSpaceAmong([
    fakeSpace(PERSONAL, [member(ME, 'admin')], [], { subspaces: inPersonal }),
    fakeSpace(teamSpace('design', 'Design'), [member(ME, 'use')]),
    platform,
  ])
  const onValueChange = vi.fn<(choice: SpaceChoice | null) => void>()
  const onChoicePress = vi.fn<() => void>()
  // The choices as a caller holds them, between two controls the Tab key can leave them for.
  const Held = ({ isDisabled }: { isDisabled: boolean }) => {
    const [value, setValue] = useState<string | null>(null)
    return (
      <div className="w-80 p-4">
        <button type="button">Before</button>
        <SpaceChoices
          spaces={spaces}
          value={value}
          disabled={isDisabled}
          onValueChange={(choice) => { onValueChange(choice); setValue(choice?.id ?? null) }}
          onChoicePress={onChoicePress}
        />
        <button type="button">After</button>
      </div>
    )
  }
  const { rerender } = await mount(<Held isDisabled={disabled} />, fakeApi({ openSpace }))
  const setDisabled = (next: boolean) => rerender(<Held isDisabled={next} />)
  return { platform, onValueChange, onChoicePress, setDisabled }
}

const radio = (name: string, occurrence = 0) => page.getByRole('radio', { name, exact: true }).nth(occurrence)
const expand = (name: string) => page.getByRole('button', { name: `Sub-spaces of ${name}`, exact: true }).first()

// The names of the radios in the order shown, and which of them are checked and focused.
const radios = () => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].map(each => ({
  name: each.closest('label')?.textContent,
  checked: each.getAttribute('aria-checked') === 'true',
  focused: document.activeElement === each,
}))
const focused = () => radios().findIndex(each => each.focused)
const checked = () => radios().flatMap((each, index) => (each.checked ? [index] : []))

// The arrow keys, which a group of radios moves its choice with, and Home and End, which the
// installed group leaves alone: `SpaceChoices` stops the arrow keys only, so a group that took
// those two would choose with them from a control that is not a radio.
const KEYS_OF_A_GROUP = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End']

describe('SpaceChoices in a browser', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('expands from the button beside a radio with a pointer, and chooses nothing', async () => {
    const { onValueChange, onChoicePress } = await render()

    // At the button's edge nearest the radio, which takes the presses that land beside it.
    const { width, height } = expand('Platform').element().getBoundingClientRect()
    await input(() => userEvent.click(expand('Platform'), { position: { x: width - 2, y: height / 2 } }))

    await expect.element(radio('Infra')).toBeVisible()
    await expect.element(radio('Ops')).toBeVisible()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(onChoicePress).not.toHaveBeenCalled()
    expect(checked()).toEqual([0])
  })

  it('moves through every radio with the arrow keys, the nested ones included, choosing as it goes', async () => {
    const { onValueChange } = await render()
    await input(() => userEvent.click(expand('Platform')))
    await expect.element(radio('Infra')).toBeVisible()
    await input(() => userEvent.click(radio('Personal')))
    onValueChange.mockClear()

    const reached: (string | null | undefined)[] = []
    for (let step = 0; step < 4; step += 1) {
      await input(() => userEvent.keyboard('{ArrowDown}'))
      const at = radios()[focused()]
      expect(at?.checked).toBe(true)
      reached.push(at?.name)
    }
    expect(reached).toEqual(['Design', 'Platform', 'Infra', 'Ops'])
    expect(onValueChange.mock.calls.map(([choice]) => choice)).toEqual([
      { id: 'design', name: 'Design' },
      { id: 'platform', name: 'Platform' },
      { id: 'infra', name: 'Infra' },
      { id: 'ops', name: 'Ops' },
    ])

    await input(() => userEvent.keyboard('{ArrowUp}'))
    expect(radios()[focused()]?.name).toBe('Infra')
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'infra', name: 'Infra' })
  })

  it('passes through both radios of a space offered twice with the arrow keys, and comes back by Tab to the one that was left', async () => {
    const { onValueChange } = await render([PERSONAL, teamSpace('infra', 'Infra', 'use'), teamSpace('platform', 'Platform')])
    await input(() => userEvent.click(expand('Platform')))
    await expect.element(radio('Ops')).toBeVisible()
    expect(radios().map(each => each.name)).toEqual(['Personal', 'Infra', 'Platform', 'Infra', 'Ops'])
    await input(() => userEvent.click(radio('Personal')))
    onValueChange.mockClear()

    await input(() => userEvent.keyboard('{ArrowDown}'))
    expect(focused()).toBe(1)
    expect(checked()).toEqual([1, 3])
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'infra', name: 'Infra' })

    await input(() => userEvent.keyboard('{ArrowDown}'))
    expect(focused()).toBe(2)
    expect(checked()).toEqual([2])

    await input(() => userEvent.keyboard('{ArrowDown}'))
    expect(focused()).toBe(3)
    expect(checked()).toEqual([1, 3])
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'infra', name: 'Infra' })
    expect(onValueChange).toHaveBeenCalledTimes(3)

    // Away to the next control, and back: to the occurrence that was left, not the first.
    await input(() => userEvent.tab())
    expect(focused()).toBe(-1)
    await input(() => userEvent.tab({ shift: true }))
    expect(focused()).toBe(3)

    await input(() => userEvent.keyboard('{ArrowDown}'))
    expect(focused()).toBe(4)
    expect(checked()).toEqual([4])
  })

  it('calls onChoicePress for a pointer press, for the Space key and for Enter, and not while the arrow keys choose', async () => {
    const { onValueChange, onChoicePress } = await render()

    await input(() => userEvent.click(radio('Design')))
    expect(onChoicePress).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'design', name: 'Design' })

    await input(() => userEvent.keyboard('{ArrowDown}'))
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'platform', name: 'Platform' })
    expect(onChoicePress).toHaveBeenCalledTimes(1)

    await input(() => userEvent.keyboard('{Enter}'))
    expect(onChoicePress).toHaveBeenCalledTimes(2)
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'platform', name: 'Platform' })
    expect(onValueChange).toHaveBeenCalledTimes(2)

    await input(() => userEvent.keyboard(' '))
    expect(onChoicePress).toHaveBeenCalledTimes(3)
    expect(onValueChange).toHaveBeenCalledTimes(2)
  })

  it('settles on nothing when a choice is pressed while disabled', async () => {
    const { onValueChange, onChoicePress } = await render(SPACES, { disabled: true })

    // The label takes the press though its radio is disabled, and the radio the focus.
    const design = radio('Design').element().closest('label')!
    await input(() => userEvent.click(design, { force: true }))
    await input(() => userEvent.click(radio('Design'), { force: true }))
    await input(() => userEvent.keyboard('{Enter}'))

    expect(onChoicePress).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
    expect(checked()).toEqual([0])
  })

  it('expands with Enter on the expand button, and settles on nothing', async () => {
    const { onValueChange, onChoicePress } = await render()

    await act(async () => { (expand('Platform').element() as HTMLElement).focus() })
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.element(radio('Infra')).toBeVisible()
    expect(onChoicePress).not.toHaveBeenCalled()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('keeps the focus on the expand button it was pressed with', async () => {
    await render()

    await input(() => userEvent.click(expand('Platform')))
    await expect.element(radio('Infra')).toBeVisible()
    await expect.element(expand('Platform')).toHaveFocus()
    await expect.element(expand('Platform')).toHaveAttribute('aria-expanded', 'true')

    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(expand('Platform')).toHaveAttribute('aria-expanded', 'false')
    await expect.element(expand('Platform')).toHaveFocus()
    expect(radios().map(each => each.name)).toEqual(['Personal', 'Design', 'Platform'])
  })

  it('gives the expand button the focus when another try shows the sub-spaces', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform } = await render()
    platform.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await input(() => userEvent.click(expand('Platform')))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Platform' })
    await expect.element(retry).toBeVisible()

    await input(() => userEvent.click(retry))

    await expect.element(radio('Infra')).toBeVisible()
    await expect.element(expand('Platform')).toHaveFocus()
  })

  it('chooses nothing and keeps the focus on an expand button when an arrow key is pressed on it, and still chooses from a radio', async () => {
    const { onValueChange } = await render()
    await act(async () => { (expand('Platform').element() as HTMLElement).focus() })
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(radio('Infra')).toBeVisible()

    for (const key of KEYS_OF_A_GROUP) {
      await input(() => userEvent.keyboard(`{${key}}`))
      await expect.element(expand('Platform')).toHaveFocus()
      expect(checked()).toEqual([0])
    }
    expect(onValueChange).not.toHaveBeenCalled()

    // Back by Tab to the chosen radio, past the expand button before it: the arrow keys choose there.
    await input(() => userEvent.tab({ shift: true }))
    await input(() => userEvent.tab({ shift: true }))
    await expect.element(radio('Personal')).toHaveFocus()
    expect(onValueChange).not.toHaveBeenCalled()
    await input(() => userEvent.keyboard('{ArrowDown}'))
    await expect.element(radio('Design')).toHaveFocus()
    expect(checked()).toEqual([1])
    expect(onValueChange.mock.calls).toEqual([[{ id: 'design', name: 'Design' }]])
  })

  it('chooses nothing and keeps the focus on Try again when an arrow key is pressed on it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform, onValueChange } = await render()
    platform.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await input(() => userEvent.click(expand('Platform')))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Platform' })
    await expect.element(retry).toBeVisible()
    await act(async () => { (retry.element() as HTMLElement).focus() })

    for (const key of KEYS_OF_A_GROUP) {
      await input(() => userEvent.keyboard(`{${key}}`))
      await expect.element(retry).toHaveFocus()
      expect(checked()).toEqual([0])
    }
    expect(onValueChange).not.toHaveBeenCalled()

    // And the keyboard goes on from there.
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(radio('Infra')).toBeVisible()
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('chooses nothing when the Tab key reaches a radio after an arrow key was pressed on an expand button', async () => {
    const { onValueChange } = await render()
    await input(() => userEvent.click(expand('Platform')))
    await input(() => userEvent.click(radio('Infra')))
    // Collapsed over the chosen space: no radio shown is the chosen one, and Tab stops on the first.
    await input(() => userEvent.click(expand('Platform')))
    expect(checked()).toEqual([])
    onValueChange.mockClear()

    await input(() => userEvent.keyboard('{ArrowDown}'))
    await expect.element(expand('Platform')).toHaveFocus()
    await input(() => userEvent.tab({ shift: true }))
    await input(() => userEvent.tab({ shift: true }))

    await expect.element(radio('Personal')).toHaveFocus()
    expect(checked()).toEqual([])
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('chooses nothing when the Tab key comes back to the only radio shown after an arrow key was pressed on it', async () => {
    const { onValueChange } = await render([PERSONAL], { inPersonal: [subspace('archive', 'Archive')] })
    await input(() => userEvent.click(expand('Personal')))
    await input(() => userEvent.click(radio('Archive')))
    // Collapsed over the chosen space: the one radio shown is not the chosen one.
    await input(() => userEvent.click(expand('Personal')))
    expect(radios().map(each => each.name)).toEqual(['Personal'])
    expect(checked()).toEqual([])
    onValueChange.mockClear()

    await input(() => userEvent.tab())
    await expect.element(radio('Personal')).toHaveFocus()
    // There is no other radio for the key to move the focus to.
    await input(() => userEvent.keyboard('{ArrowDown}'))
    await expect.element(radio('Personal')).toHaveFocus()
    await input(() => userEvent.tab({ shift: true }))
    await expect.element(expand('Personal')).toHaveFocus()
    await input(() => userEvent.tab())

    await expect.element(radio('Personal')).toHaveFocus()
    expect(checked()).toEqual([])
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it.each<[string, (setDisabled: (next: boolean) => Promise<void>) => Promise<void>]>([
    ['with Control held', () => input(() => userEvent.keyboard('{Control>}{ArrowDown}{/Control}'))],
    ['with Alt held', () => input(() => userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}'))],
    ['with Meta held', () => input(() => userEvent.keyboard('{Meta>}{ArrowDown}{/Meta}'))],
    // As while a move is under way, which may then fail.
    ['while nothing could be chosen', async (setDisabled) => {
      await setDisabled(true)
      await input(() => userEvent.keyboard('{ArrowDown}'))
      await setDisabled(false)
    }],
  ])('chooses nothing when the Tab key comes back to a radio after an arrow key was pressed on it %s', async (_way, press) => {
    const { onValueChange, setDisabled } = await render()
    await input(() => userEvent.click(expand('Platform')))
    await input(() => userEvent.click(radio('Infra')))
    // Collapsed over the chosen space: no radio shown is the chosen one, and Tab stops on the first.
    await input(() => userEvent.click(expand('Platform')))
    expect(checked()).toEqual([])
    onValueChange.mockClear()
    await input(() => userEvent.tab({ shift: true }))
    await input(() => userEvent.tab({ shift: true }))
    await expect.element(radio('Personal')).toHaveFocus()

    // A group of radios moves nothing for the key pressed this way.
    await press(setDisabled)
    await expect.element(radio('Personal')).toHaveFocus()
    await input(() => userEvent.tab({ shift: true }))
    await expect.element(expand('Personal')).toHaveFocus()
    await input(() => userEvent.tab())

    await expect.element(radio('Personal')).toHaveFocus()
    expect(checked()).toEqual([])
    expect(onValueChange).not.toHaveBeenCalled()
  })
})
