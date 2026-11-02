// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
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
  teamSpace,
  type,
  unmountAll,
} from './spacesTestUtils'
import { WorkspaceAddressDialog } from './WorkspaceAddressDialog'

const ROADMAP: SpaceWorkspaceInfo = {
  id: 'w-roadmap',
  title: 'Roadmap',
  owner: ME,
  created: new Date('2026-09-01T00:00:00Z'),
  slug: 'roadmap',
}

const RULE = 'Lowercase letters and digits, in groups joined by single dashes, 80 characters at most.'
const IN_USE = 'Another workspace of this space is at “plan”. Choose another address.'

const render = async (workspace: SpaceWorkspaceInfo = ROADMAP) => {
  const space = fakeSpace(teamSpace('design', 'Design'), [member(ME, 'admin')], [workspace])
  const openSpace = vi.fn<(key: string) => unknown>(() => space)
  const onChanged = vi.fn<(workspace: SpaceWorkspaceInfo) => void>()
  await mount(
    <WorkspaceAddressDialog
      spaceKey="design"
      workspace={workspace}
      onClose={() => {}}
      onChanged={onChanged}
    />,
    fakeApi({ openSpace }),
  )
  return { space, openSpace, onChanged }
}

const dialogText = () => document.body.querySelector('[role="dialog"]')?.textContent

describe('WorkspaceAddressDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows the address the workspace has, and saves nothing until it is another one', async () => {
    const { space } = await render()

    expect(dialogText()).toContain('Current address: /spaces/design/roadmap')
    expect(labeledInput('Address').value).toBe('roadmap')
    expect(describedBy(labeledInput('Address'))).toBe(RULE)
    expect(button('Save').disabled).toBe(true)

    await type(labeledInput('Address'), '')
    expect(button('Save').disabled).toBe(true)
    labeledInput('Address').form!.requestSubmit()
    expect(space.setWorkspaceSlug).not.toHaveBeenCalled()
  })

  it('names a workspace that has no title as its row does', async () => {
    await render({ ...ROADMAP, title: '' })

    expect(dialogText()).toContain('Where “Untitled Workspace” is found in this space.')
  })

  it('says so when the workspace has no address yet', async () => {
    await render({ ...ROADMAP, slug: undefined })

    expect(dialogText()).toContain('It has no address in this space yet.')
    expect(labeledInput('Address').value).toBe('')
  })

  it('keeps what is typed in slug form, and shows the address it gives', async () => {
    await render()

    await type(labeledInput('Address'), '  Café  Menu_2')
    expect(labeledInput('Address').value).toBe('cafe-menu-2')
    expect(describedBy(labeledInput('Address'))).toBe('It will be at /spaces/design/cafe-menu-2')

    // Nothing that leaves no letter or digit becomes a slug of its own.
    await type(labeledInput('Address'), '!!!')
    expect(labeledInput('Address').value).toBe('')
  })

  it('leaves the caret after what was typed before it', async () => {
    await render()

    // A space typed after the fourth character.
    const address = labeledInput('Address')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, 'road map')
      address.setSelectionRange(5, 5)
      address.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(address.value).toBe('road-map')
    expect([address.selectionStart, address.selectionEnd]).toEqual([5, 5])
  })

  it('leaves what an input method is composing as typed, until it is composed', async () => {
    await render()
    const address = labeledInput('Address')
    const compose = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(address, value)
      address.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
    })

    // A dead key's accent, which is no part of a slug, before the letter it goes on.
    await compose('caf´')
    expect(address.value).toBe('caf´')

    await compose('café')
    await act(async () => {
      address.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'é' }))
    })
    expect(address.value).toBe('cafe')
    expect(describedBy(address)).toBe('It will be at /spaces/design/cafe')
  })

  it('keeps all of an address that is too long, and says so against the field', async () => {
    const { space } = await render()

    await type(labeledInput('Address'), 'x'.repeat(81))
    expect(labeledInput('Address').value).toBe('x'.repeat(81))
    expect(describedBy(labeledInput('Address'))).toBe('An address is 80 characters at most.')
    expect(labeledInput('Address').getAttribute('aria-invalid')).toBe('true')
    expect(button('Save').disabled).toBe(true)
    labeledInput('Address').form!.requestSubmit()
    expect(space.setWorkspaceSlug).not.toHaveBeenCalled()

    await type(labeledInput('Address'), 'x'.repeat(80))
    expect(button('Save').disabled).toBe(false)
  })

  it('holds the address to slug form before asking the space for it', async () => {
    const { space } = await render()

    // The dash a next word would join is kept while typing, and is not a slug's last character.
    await type(labeledInput('Address'), 'road-')
    expect(labeledInput('Address').value).toBe('road-')
    await click(button('Save'))

    expect(space.setWorkspaceSlug).not.toHaveBeenCalled()
    expect(describedBy(labeledInput('Address'))).toBe('An address ends with a letter or a digit.')
    expect(labeledInput('Address').getAttribute('aria-invalid')).toBe('true')
  })

  it('changes the address, and lets the space go', async () => {
    const { space, openSpace, onChanged } = await render()

    await type(labeledInput('Address'), 'plan')
    await click(button('Save'))

    expect(openSpace).toHaveBeenCalledExactlyOnceWith('design')
    expect(space.setWorkspaceSlug).toHaveBeenCalledExactlyOnceWith('w-roadmap', 'plan')
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({ ...ROADMAP, slug: 'plan' })
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('shows an address another workspace uses against the field, until it is edited', async () => {
    const { space, onChanged } = await render()
    space.setWorkspaceSlug.mockRejectedValueOnce(
      new Error('Another workspace of this space already uses that slug.'))

    await type(labeledInput('Address'), 'plan')
    await click(button('Save'))

    expect(onChanged).not.toHaveBeenCalled()
    expect(describedBy(labeledInput('Address'))).toBe(IN_USE)
    expect(labeledInput('Address').getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(labeledInput('Address'))
    expect(button('Save').disabled).toBe(true)
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()

    // The workspace that has the address may give it up, so the same one can be asked for again.
    await type(labeledInput('Address'), 'pla')
    await type(labeledInput('Address'), 'plan')
    expect(labeledInput('Address').getAttribute('aria-invalid')).not.toBe('true')
    await click(button('Save'))
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('says so when the address could not be changed for another reason', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { space, onChanged } = await render()
    space.setWorkspaceSlug.mockRejectedValueOnce(
      new Error('Only a workspace\'s owner or an admin of this space can change its slug.'))

    await type(labeledInput('Address'), 'plan')
    await click(button('Save'))

    expect(onChanged).not.toHaveBeenCalled()
    expect(alerts()).toEqual(['Only a workspace\'s owner or an admin of this space can change its slug.'])
    expect(button('Save').disabled).toBe(false)
  })
})
