/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { NewSpaceDialog } from './NewSpaceDialog'
import { ME, fakeApi, fakeSpace, member, mount, personalSpace, teamSpace, unmountAll } from './spacesTestUtils'
import '../../styles.css'

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// The dialog over a creation that answers with `space`.
const render = async (space: ReturnType<typeof fakeSpace>) => {
  const createSpace = vi.fn<(name: string) => unknown>(() => space)
  const onCreated = vi.fn<(id: string) => void>()
  await mount(
    <NewSpaceDialog
      spaces={{ enabled: true, spaces: [personalSpace(ME)], loading: false, failed: false, refresh: async () => {} }}
      onClose={() => {}}
      onCreated={onCreated}
    />,
    fakeApi({ createSpace }),
  )
  return { createSpace, onCreated }
}

const platform = () => fakeSpace(teamSpace('space-1', 'Platform'), [member(ME, 'admin')])

describe('NewSpaceDialog in a browser', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  // The button that submits the form is outside it, in the dialog's footer.
  it('creates the space on Enter in the name field', async () => {
    const { createSpace, onCreated } = await render(platform())

    await input(() => userEvent.fill(page.getByRole('textbox', { name: 'Name' }), '  Platform '))
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.poll(() => onCreated.mock.calls).toEqual([['space-1']])
    expect(createSpace).toHaveBeenCalledExactlyOnceWith('Platform')
  })

  it('keeps the focus on Create while the space is created and when the server refuses it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = platform()
    let refuse!: (err: Error) => void
    space.getInfo.mockReturnValue(new Promise<SpaceInfo>((_, reject) => { refuse = reject }))
    const { createSpace } = await render(space)

    await input(() => userEvent.fill(page.getByRole('textbox', { name: 'Name' }), 'Platform'))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Create' })))
    // The spinner is part of the busy button's name, which a string would have to give whole.
    await expect.element(page.getByRole('button', { name: /Creating…/ })).toHaveFocus()

    // A press while the creation is in flight, by the keyboard the focus still serves.
    await input(() => userEvent.keyboard('{Enter}'))
    expect(createSpace).toHaveBeenCalledOnce()

    await act(async () => refuse(new Error('A space name is 1 to 100 characters.')))
    await expect.element(page.getByRole('alert')).toHaveTextContent('A space name is 1 to 100 characters.')
    await expect.element(page.getByRole('button', { name: 'Create' })).toHaveFocus()
  })
})
