// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceSpaceSelect } from './NewWorkspaceSpaceSelect'
import type { SpaceChoice } from './SpaceChoices'
import {
  ME,
  button,
  click,
  fakeApi,
  fakeSpace,
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

const render = async (value: SpaceChoice | null, { disabled = false } = {}) => {
  const onValueChange = vi.fn<(choice: SpaceChoice | null) => void>()
  const openSpace = openSpaceAmong([
    fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')], [], {
      subspaces: [subspace('infra', 'Infra')],
    }),
  ])
  // The picker as the screen holds it: the value follows what is chosen.
  const Held = () => {
    const [held, setHeld] = useState(value)
    return (
      <NewWorkspaceSpaceSelect
        spaces={SPACES}
        value={held}
        disabled={disabled}
        onValueChange={(choice) => { onValueChange(choice); setHeld(choice) }}
      />
    )
  }
  await mount(<Held />, fakeApi({ openSpace }))
  return { onValueChange }
}

const popup = () => document.body.querySelector<HTMLElement>('[role="dialog"]')

const labels = () => [...document.body.querySelectorAll('label')]
  .filter(label => label.querySelector('[role="radio"]'))

const offered = () => labels().map(label => ({
  name: label.textContent,
  checked: label.querySelector('[role="radio"]')!.getAttribute('aria-checked') === 'true',
}))

// The label, which is what a pointer lands on. jsdom has no PointerEvent, which the radio itself
// forwards its clicks with.
const choose = async (name: string) => {
  await click(labels().find(label => label.textContent === name)!)
  await settle()
}

describe('NewWorkspaceSpaceSelect', () => {
  afterEach(unmountAll)

  it('names the chosen space on its button, and the personal space when none is', async () => {
    await render({ id: 'platform', name: 'Platform' })
    expect(button('Space: Platform').textContent).toBe('Platform')
    unmountAll()

    await render(null)
    expect(button('Space: Personal').textContent).toBe('Personal')
    // The word beside the button is the button's name already.
    expect(document.body.querySelector('[aria-hidden="true"]')?.textContent).toBe('Space')
  })

  it('shows no id', async () => {
    const id = '0123456789abcdef'.repeat(4)
    await render({ id, name: 'Infra' })

    expect(button('Space: Infra').textContent).toBe('Infra')
    expect(document.body.textContent).toBe('SpaceInfra')
  })

  it('offers the user’s spaces when opened, in a popup named Space, and reports the personal space as null and another by its id and name', async () => {
    const { onValueChange } = await render({ id: 'platform', name: 'Platform' })
    expect(popup()).toBeNull()

    await click(button('Space: Platform'))
    expect(document.getElementById(popup()!.getAttribute('aria-labelledby')!)?.textContent).toBe('Space')
    expect(offered()).toEqual([
      { name: 'Personal', checked: false },
      { name: 'Design', checked: false },
      { name: 'Platform', checked: true },
    ])

    await choose('Personal')
    expect(onValueChange).toHaveBeenLastCalledWith(null)

    await click(button('Space: Personal'))
    await choose('Design')
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'design', name: 'Design' })
    expect(button('Space: Design').textContent).toBe('Design')
  })

  it('offers a space’s sub-spaces when it is expanded, and reports the one chosen', async () => {
    const { onValueChange } = await render(null)
    await click(button('Space: Personal'))

    await click(button('Sub-spaces of Platform'))
    await settle()
    expect(popup()).not.toBeNull()
    expect(offered().map(each => each.name)).toEqual(['Personal', 'Design', 'Platform', 'Infra'])

    await choose('Infra')
    expect(onValueChange).toHaveBeenCalledExactlyOnceWith({ id: 'infra', name: 'Infra' })
    expect(button('Space: Infra').textContent).toBe('Infra')
  })

  it('closes when a space is pressed', async () => {
    await render(null)
    await click(button('Space: Personal'))
    expect(offered()).toHaveLength(3)

    await choose('Design')

    expect(offered()).toEqual([])
    expect(popup()).toBeNull()
  })

  it('does not open while the workspace is being created', async () => {
    await render(null, { disabled: true })

    expect(button('Space: Personal').disabled).toBe(true)
    await click(button('Space: Personal'))

    expect(popup()).toBeNull()
  })
})
