// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceSpaceSelect } from './NewWorkspaceSpaceSelect'
import { button, chooseOption, fakeApi, mount, selectOptions, teamSpace, unmountAll } from './spacesTestUtils'

const TEAM_SPACES = [teamSpace('design', 'Design', 'use'), teamSpace('platform', 'Platform')]

const render = async (value: string | null) => {
  const onValueChange = vi.fn<(spaceId: string | null) => void>()
  await mount(
    <NewWorkspaceSpaceSelect
      teamSpaces={TEAM_SPACES}
      value={value}
      disabled={false}
      onValueChange={onValueChange}
    />,
    fakeApi(),
  )
  return { onValueChange }
}

describe('NewWorkspaceSpaceSelect', () => {
  afterEach(unmountAll)

  it('names the chosen team space', async () => {
    await render('platform')

    expect(button('Space').textContent).toBe('Platform')
  })

  it('reads as the personal space, and shows no id, for a value that is none of the team spaces', async () => {
    const id = '0123456789abcdef'.repeat(4)
    await render(id)

    expect(button('Space').textContent).toBe('Personal')
    const selected = (await selectOptions('Space')).filter(option => option.getAttribute('aria-selected') === 'true')
    expect(selected.map(option => option.textContent)).toEqual(['Personal'])
    expect(document.body.textContent).not.toContain(id)
  })

  it('reports the personal space as null and a team space by its id', async () => {
    const { onValueChange } = await render('platform')

    await chooseOption('Space', 'Personal')
    expect(onValueChange).toHaveBeenLastCalledWith(null)

    await chooseOption('Space', 'Design')
    expect(onValueChange).toHaveBeenLastCalledWith('design')
  })
})
