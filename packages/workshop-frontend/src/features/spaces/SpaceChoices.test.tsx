// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceInfo, SubspaceInfo } from '@gadgets/workshop-shared/api'
import { SpaceChoices, type SpaceChoice } from './SpaceChoices'
import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  hasButton,
  member,
  mount,
  openSpaceAmong,
  personalSpace,
  settle,
  subspace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

const PERSONAL = personalSpace(ME)
const SPACES = [PERSONAL, teamSpace('design', 'Design', 'use'), teamSpace('platform', 'Platform')]

// A space under another, which the user is a member of through the space above it.
const below = (id: string, name: string, parent: string, subspaces: SubspaceInfo[] = []) =>
  fakeSpace(teamSpace(id, name, 'build', parent), [], [], { inherited: 'build', subspaces })

// Personal holds Notes. Platform holds Infra and Ops, Infra holds Deploy, Deploy holds Canary.
// Design holds nothing.
const fakes = () => {
  const personal = fakeSpace(PERSONAL, [member(ME, 'admin')], [], { subspaces: [subspace('notes', 'Notes')] })
  const design = fakeSpace(teamSpace('design', 'Design'), [member(ME, 'use')])
  const platform = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')], [], {
    // Created in this order: the space lists them by name.
    subspaces: [subspace('ops', 'Ops'), subspace('infra', 'Infra')],
  })
  const infra = below('infra', 'Infra', 'platform', [subspace('deploy', 'Deploy')])
  const deploy = below('deploy', 'Deploy', 'infra', [subspace('canary', 'Canary')])
  return { personal, design, platform, infra, deploy }
}

const render = async ({
  spaces = SPACES,
  value = null,
  current,
  disabled = false,
  spacesFlag = true,
  reportsPress = true,
  among = fakes(),
}: {
  spaces?: SpaceInfo[]
  value?: string | null
  current?: string | null
  disabled?: boolean
  spacesFlag?: boolean
  reportsPress?: boolean
  among?: ReturnType<typeof fakes>
} = {}) => {
  const openSpace = openSpaceAmong(Object.values(among))
  const onValueChange = vi.fn<(choice: SpaceChoice | null) => void>()
  const onChoicePress = vi.fn<() => void>()
  // The choices as a caller holds them: the value follows what is chosen.
  const Held = () => {
    const [held, setHeld] = useState(value)
    return (
      <SpaceChoices
        spaces={spaces}
        value={held}
        current={current}
        disabled={disabled}
        onValueChange={(choice) => { onValueChange(choice); setHeld(choice?.id ?? null) }}
        onChoicePress={reportsPress ? onChoicePress : undefined}
      />
    )
  }
  await mount(<Held />, fakeApi({ openSpace }, { spacesFlag }))
  return { ...among, openSpace, onValueChange, onChoicePress }
}

const labels = () => [...document.body.querySelectorAll('label')]
  .filter(label => label.querySelector('[role="radio"]'))

const radioOf = (label: HTMLElement) => label.querySelector<HTMLElement>('[role="radio"]')!

// Every radio in the order shown.
const choices = () => labels().map(label => ({
  name: label.textContent,
  checked: radioOf(label).getAttribute('aria-checked') === 'true',
}))

const names = () => choices().map(choice => choice.name)

const labelOf = (name: string, occurrence = 0) => labels().filter(label => label.textContent === name)[occurrence]!

// The label, which is what a pointer lands on. jsdom has no PointerEvent, which the radio itself
// forwards its clicks with.
const choose = (name: string, occurrence = 0) => click(labelOf(name, occurrence))

const expandButtons = (name: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
  .filter(candidate => candidate.getAttribute('aria-label') === `Sub-spaces of ${name}`)

const toggle = async (name: string, occurrence = 0) => {
  await click(expandButtons(name)[occurrence]!)
  await settle()
}

const groups = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>(`[role="group"][aria-label="Sub-spaces of ${name}"]`)]

const pressEnterOn = (element: HTMLElement) => act(async () => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
})

describe('SpaceChoices', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('offers the personal space and the spaces of the user’s list, with the chosen one checked', async () => {
    await render({ value: 'platform' })

    expect(choices()).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Design', checked: false },
      { name: 'Platform', checked: true },
    ])
    const group = document.body.querySelector('fieldset')!
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Space')
    for (const name of ['Personal', 'Design', 'Platform']) {
      expect(expandButtons(name).map(each => each.getAttribute('aria-expanded'))).toEqual(['false'])
    }
  })

  it('offers the personal space alone, with nothing to expand, while the list has not loaded', async () => {
    const { openSpace } = await render({ spaces: [] })

    expect(choices()).toEqual([{ name: 'Personal', checked: true }])
    expect(document.body.querySelectorAll('button')).toHaveLength(0)
    expect(openSpace).not.toHaveBeenCalled()
  })

  it('reads nothing until a space is expanded, then that space’s sub-spaces on one open that it releases', async () => {
    const { openSpace, platform, onValueChange } = await render()
    await settle()
    expect(openSpace).not.toHaveBeenCalled()

    await toggle('Platform')

    expect(openSpace.mock.calls).toEqual([['platform']])
    expect(platform.listSubspaces).toHaveBeenCalledOnce()
    expect(platform.getInfo).not.toHaveBeenCalled()
    expect(platform[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(names()).toEqual(['Personal', 'Design', 'Platform', 'Infra', 'Ops'])
    const [expand] = expandButtons('Platform')
    expect(expand!.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(expand!.getAttribute('aria-controls')!)).toBe(groups('Platform')[0])
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('expands a sub-space in turn, three levels down', async () => {
    const { openSpace } = await render()

    await toggle('Platform')
    await toggle('Infra')
    await toggle('Deploy')

    expect(names()).toEqual(['Personal', 'Design', 'Platform', 'Infra', 'Deploy', 'Canary', 'Ops'])
    expect(openSpace.mock.calls).toEqual([['platform'], ['infra'], ['deploy']])
    // Each level is inside the one above it.
    expect(groups('Platform')[0]!.contains(groups('Infra')[0]!)).toBe(true)
    expect(groups('Infra')[0]!.contains(groups('Deploy')[0]!)).toBe(true)
    expect(groups('Deploy')[0]!.contains(labelOf('Canary'))).toBe(true)
    expect(expandButtons('Canary')).toHaveLength(1)
  })

  it('expands the personal space to its sub-spaces', async () => {
    const { openSpace, personal } = await render()

    await toggle('Personal')

    expect(openSpace.mock.calls).toEqual([[PERSONAL.id]])
    expect(personal.listSubspaces).toHaveBeenCalledOnce()
    expect(names()).toEqual(['Personal', 'Notes', 'Design', 'Platform'])
    expect(groups('Personal')[0]!.contains(labelOf('Notes'))).toBe(true)
  })

  it('reports a sub-space by its id and name, and the personal space as null', async () => {
    const { onValueChange } = await render({ value: 'design' })
    await toggle('Platform')

    await choose('Infra')
    expect(onValueChange.mock.calls).toEqual([[{ id: 'infra', name: 'Infra' }]])
    expect(choices().filter(choice => choice.checked)).toEqual([{ name: 'Infra', checked: true }])

    await choose('Personal')
    expect(onValueChange).toHaveBeenLastCalledWith(null)

    await choose('Platform')
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'platform', name: 'Platform' })
  })

  it('marks the current space wherever it is offered, a sub-space included', async () => {
    const { onValueChange } = await render({ value: null, current: 'infra' })
    expect(names()).toEqual(['Personal', 'Design', 'Platform'])

    await toggle('Platform')
    expect(names()).toEqual(['Personal', 'Design', 'Platform', 'Infra (current)', 'Ops'])

    // The name reported is the space's own.
    await choose('Infra (current)')
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'infra', name: 'Infra' })
    unmountAll()

    await render({ value: 'design', current: null })
    expect(names()).toEqual(['Personal (current)', 'Design', 'Platform'])
    unmountAll()

    await render({ value: 'design', current: 'design' })
    expect(names()).toEqual(['Personal', 'Design (current)', 'Platform'])
  })

  it('offers a space the user was added to at the top level and again under the space above it, and checks both when it is chosen', async () => {
    const { openSpace, onValueChange } = await render({
      spaces: [PERSONAL, teamSpace('infra', 'Infra', 'use'), teamSpace('platform', 'Platform')],
    })
    await toggle('Platform')
    expect(names()).toEqual(['Personal', 'Infra', 'Platform', 'Infra', 'Ops'])

    await choose('Infra', 1)
    expect(onValueChange.mock.calls).toEqual([[{ id: 'infra', name: 'Infra' }]])
    expect(choices()).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Infra', checked: true },
      { name: 'Platform', checked: false },
      { name: 'Infra', checked: true },
      { name: 'Ops', checked: false },
    ])

    // Expanding one occurrence expands both, on one read, and each names its own group.
    await toggle('Infra', 1)
    expect(openSpace.mock.calls).toEqual([['platform'], ['infra']])
    expect(names()).toEqual(['Personal', 'Infra', 'Deploy', 'Platform', 'Infra', 'Deploy', 'Ops'])
    const controlled = expandButtons('Infra').map(each => document.getElementById(each.getAttribute('aria-controls')!))
    expect(controlled).toEqual(groups('Infra'))
    expect(controlled[0]).not.toBe(controlled[1])
    expect(expandButtons('Infra').map(each => each.getAttribute('aria-expanded'))).toEqual(['true', 'true'])
  })

  it('says that a space has no sub-spaces', async () => {
    await render()

    await toggle('Design')

    expect(groups('Design')[0]!.textContent).toBe('No sub-spaces.')
    expect(alerts()).toEqual([])
  })

  it('says that the sub-spaces are being read until they have been', async () => {
    const among = fakes()
    const slow = deferred<SubspaceInfo[]>()
    among.design.listSubspaces.mockImplementation(() => slow.promise)
    await render({ among })

    await toggle('Design')
    const [group] = groups('Design')
    expect(group!.querySelector('[role="status"]')?.textContent).toBe('Loading…')
    expect(group!.textContent).toBe('Loading…')

    await act(async () => slow.resolve([subspace('brand', 'Brand')]))
    await settle()
    expect(groups('Design')[0]!.querySelector('[role="status"]')).toBeNull()
    expect(names()).toEqual(['Personal', 'Design', 'Brand', 'Platform'])
  })

  it('says that the sub-spaces could not be read, and reads them again once from a button that stays enabled and marked busy', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const among = fakes()
    among.platform.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await render({ among })

    await toggle('Platform')
    expect(alerts()).toEqual(['Couldn’t load the sub-spaces.'])
    expect(names()).toEqual(['Personal', 'Design', 'Platform'])

    const again = deferred<SubspaceInfo[]>()
    among.platform.listSubspaces.mockImplementationOnce(() => again.promise)
    const retry = button('Try again to load the sub-spaces of Platform')
    expect(retry.textContent).toBe('Try again')
    await click(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    await click(retry)
    expect(among.platform.listSubspaces).toHaveBeenCalledTimes(2)

    await act(async () => again.resolve([subspace('infra', 'Infra')]))
    await settle()
    expect(alerts()).toEqual([])
    expect(hasButton('Try again to load the sub-spaces of Platform')).toBe(false)
    expect(names()).toEqual(['Personal', 'Design', 'Platform', 'Infra'])
  })

  it('gives the expand button the focus of a Try again that went, without waiting for a frame', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // No frame comes, so only what is done at once shows.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    const among = fakes()
    among.platform.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await render({ among })
    await toggle('Platform')

    const retry = button('Try again to load the sub-spaces of Platform')
    retry.focus()
    await click(retry)
    await settle()

    expect(hasButton('Try again to load the sub-spaces of Platform')).toBe(false)
    expect(document.activeElement).toBe(expandButtons('Platform')[0])
  })

  it('leaves the focus on a Try again that failed again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const among = fakes()
    among.platform.listSubspaces.mockRejectedValue(new Error('boom'))
    await render({ among })
    await toggle('Platform')

    const retry = button('Try again to load the sub-spaces of Platform')
    retry.focus()
    await click(retry)
    await settle()

    expect(among.platform.listSubspaces).toHaveBeenCalledTimes(2)
    expect(document.activeElement).toBe(button('Try again to load the sub-spaces of Platform'))
  })

  it('says that the user is no longer a member when the space refuses', async () => {
    // In the list as last read, and refusing the user since.
    await render({ spaces: [...SPACES, teamSpace('left', 'Left')] })

    await toggle('Left')

    expect(alerts()).toEqual(['You are no longer a member of this space.'])
    expect(groups('Left')[0]!.querySelector('button')).toBeNull()
  })

  it('keeps the choice when the space it is inside is collapsed', async () => {
    const { onValueChange } = await render()
    await toggle('Platform')
    await choose('Infra')

    await toggle('Platform')
    expect(names()).toEqual(['Personal', 'Design', 'Platform'])
    expect(choices().some(choice => choice.checked)).toBe(false)

    await toggle('Platform')
    expect(choices().filter(choice => choice.checked)).toEqual([{ name: 'Infra', checked: true }])
    expect(onValueChange).toHaveBeenCalledOnce()
  })

  it('lets nothing be chosen or expanded while disabled', async () => {
    const { openSpace, onValueChange, onChoicePress } = await render({ disabled: true })

    for (const name of ['Personal', 'Design', 'Platform']) {
      expect(expandButtons(name).map(each => each.disabled)).toEqual([true])
    }
    await toggle('Platform')
    await choose('Design')

    expect(openSpace).not.toHaveBeenCalled()
    expect(names()).toEqual(['Personal', 'Design', 'Platform'])
    expect(onValueChange).not.toHaveBeenCalled()
    expect(onChoicePress).not.toHaveBeenCalled()
    expect(choices()[0]).toEqual({ name: 'Personal', checked: true })
  })

  it('asks nothing when a space is expanded while the flag is off', async () => {
    const { openSpace } = await render({ spacesFlag: false })

    await toggle('Platform')

    expect(openSpace).not.toHaveBeenCalled()
    expect(names()).toEqual(['Personal', 'Design', 'Platform'])
  })

  it('opens once a space that is still being read when another is expanded', async () => {
    const among = fakes()
    const slow = deferred<SubspaceInfo[]>()
    among.platform.listSubspaces.mockImplementation(() => slow.promise)
    const { openSpace } = await render({ among })

    await toggle('Platform')
    await toggle('Personal')
    expect(openSpace.mock.calls).toEqual([['platform'], [PERSONAL.id]])

    await act(async () => slow.resolve([subspace('infra', 'Infra')]))
    await settle()
    expect(openSpace.mock.calls).toEqual([['platform'], [PERSONAL.id]])
    expect(among.platform[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(names()).toEqual(['Personal', 'Notes', 'Design', 'Platform', 'Infra'])
  })

  it('reports a press on a choice, the one already chosen included, and none for the expand button', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const among = fakes()
    among.design.listSubspaces.mockRejectedValue(new Error('boom'))
    const { onChoicePress, onValueChange } = await render({ among })

    await toggle('Platform')
    await toggle('Design')
    await click(button('Try again to load the sub-spaces of Design'))
    await settle()
    expect(onChoicePress).not.toHaveBeenCalled()

    await choose('Infra')
    expect(onChoicePress).toHaveBeenCalledOnce()
    expect(onValueChange).toHaveBeenCalledOnce()

    // The one chosen already: nothing changes, and the user has settled on it all the same.
    await choose('Infra')
    expect(onChoicePress).toHaveBeenCalledTimes(2)
    expect(onValueChange).toHaveBeenCalledOnce()
  })

  it('reports Enter on a choice, and not Enter on the expand button', async () => {
    const { onChoicePress, onValueChange } = await render()

    await pressEnterOn(expandButtons('Platform')[0]!)
    expect(onChoicePress).not.toHaveBeenCalled()

    await pressEnterOn(radioOf(labelOf('Personal')))
    expect(onChoicePress).toHaveBeenCalledOnce()
    // The one chosen already: nothing changes.
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('chooses on Enter a space that is not the chosen one, before it reports the press', async () => {
    const { onChoicePress, onValueChange } = await render({ value: 'infra' })
    // The chosen space is inside Platform, which is not expanded: no radio shown is the chosen one.
    expect(choices().some(choice => choice.checked)).toBe(false)

    await pressEnterOn(radioOf(labelOf('Personal')))

    expect(onValueChange.mock.calls).toEqual([[null]])
    expect(onChoicePress).toHaveBeenCalledOnce()
    expect(onValueChange.mock.invocationCallOrder[0]).toBeLessThan(onChoicePress.mock.invocationCallOrder[0]!)
    expect(choices().filter(choice => choice.checked)).toEqual([{ name: 'Personal', checked: true }])

    await pressEnterOn(radioOf(labelOf('Design')))
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'design', name: 'Design' })
    expect(onChoicePress).toHaveBeenCalledTimes(2)
  })

  it('does nothing on Enter where the caller asks for no report of a press', async () => {
    const { onValueChange, onChoicePress } = await render({ reportsPress: false })

    await pressEnterOn(radioOf(labelOf('Design')))
    // Design is not the chosen space, and Enter did not choose it.
    expect(onValueChange).not.toHaveBeenCalled()
    expect(onChoicePress).not.toHaveBeenCalled()

    await choose('Design')
    expect(onValueChange.mock.calls).toEqual([[{ id: 'design', name: 'Design' }]])
  })
})
