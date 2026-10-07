// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  alerts,
  button,
  chooseOption,
  click,
  deferred,
  fakeApi,
  mount,
  pressEscape,
  selectOptions,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import { MoveWorkspaceDialog } from './MoveWorkspaceDialog'

const DAY = new Date('2026-09-01T00:00:00Z')

const entry = (id: string, title: string, parentId?: string): SpaceWorkspaceInfo =>
  ({ id, title, owner: ME, created: DAY, ...(parentId && { parentId }) })

// Handbook > (Onboarding > Checklist, Policies); Roadmap; Notes.
const HANDBOOK = entry('w-handbook', 'Handbook')
const ONBOARDING = entry('w-onboarding', 'Onboarding', 'w-handbook')
const CHECKLIST = entry('w-checklist', 'Checklist', 'w-onboarding')
const POLICIES = entry('w-policies', 'Policies', 'w-handbook')
const ROADMAP = entry('w-roadmap', 'Roadmap')
const NOTES = entry('w-notes', 'Notes')
const LISTING = [HANDBOOK, ONBOARDING, CHECKLIST, POLICIES, ROADMAP, NOTES]

type OnMove = (parentId: string | null, beforeId?: string) => Promise<void>

const render = async (workspace: SpaceWorkspaceInfo, onMove = vi.fn<OnMove>(async () => {})) => {
  const onClose = vi.fn<() => void>()
  await mount(
    <MoveWorkspaceDialog workspace={workspace} listing={LISTING} onClose={onClose} onMove={onMove} />,
    fakeApi(),
  )
  return { onMove, onClose }
}

const optionTexts = async (label: string) => (await selectOptions(label)).map(option => option.textContent)
const dialog = () => document.body.querySelector('[role="dialog"]')!

describe('MoveWorkspaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('is a dialog named for the workspace, starting from where it is now, with nothing to move yet', async () => {
    const { onMove } = await render(ONBOARDING)

    expect(dialog().getAttribute('aria-labelledby')).toBeTruthy()
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)?.textContent).toBe('Move “Onboarding”')
    expect(button('Parent').textContent).toBe('Handbook')
    expect(button('Position').textContent).toBe('First')
    expect(button('Move').disabled).toBe(true)
    expect(onMove).not.toHaveBeenCalled()
  })

  it('offers every parent but the workspace and what is under it, in tree order', async () => {
    await render(ONBOARDING)

    expect(await optionTexts('Parent')).toEqual(['Top of the space', 'Handbook', 'Policies', 'Roadmap', 'Notes'])
  })

  it('places the workspace after a sibling, anchored before the sibling that follows, or last', async () => {
    const { onMove } = await render(ONBOARDING)

    expect(await optionTexts('Position')).toEqual(['First', 'After Policies'])
    await chooseOption('Position', 'After Policies')
    await click(button('Move'))
    expect(onMove).toHaveBeenLastCalledWith('w-handbook', undefined)
  })

  it('places a workspace first under a new parent before its first child', async () => {
    const { onMove } = await render(NOTES)

    await chooseOption('Parent', 'Handbook')
    // A new parent starts with the workspace after its last child.
    expect(button('Position').textContent).toBe('After Policies')
    await chooseOption('Position', 'First')
    await click(button('Move'))
    expect(onMove).toHaveBeenLastCalledWith('w-handbook', 'w-onboarding')
  })

  it('anchors a place between two siblings on the one it comes before', async () => {
    const { onMove } = await render(NOTES)

    expect(await optionTexts('Position')).toEqual(['First', 'After Handbook', 'After Roadmap'])
    await chooseOption('Position', 'After Handbook')
    await click(button('Move'))
    expect(onMove).toHaveBeenLastCalledWith(null, 'w-roadmap')
  })

  it('moves a workspace to the top of the space, and under a workspace with nothing under it', async () => {
    const { onMove } = await render(ONBOARDING)

    await chooseOption('Parent', 'Top of the space')
    expect(button('Position').textContent).toBe('After Notes')
    await click(button('Move'))
    expect(onMove).toHaveBeenLastCalledWith(null, undefined)

    await chooseOption('Parent', 'Roadmap')
    expect(await optionTexts('Position')).toEqual(['Only workspace here'])
    await click(button('Move'))
    expect(onMove).toHaveBeenLastCalledWith('w-roadmap', undefined)
  })

  it('falls back to where the workspace is, or the top, when the chosen parent leaves the listing', async () => {
    const onMove = vi.fn<OnMove>(async () => {})
    const ui = (listing: readonly SpaceWorkspaceInfo[]) => (
      <MoveWorkspaceDialog workspace={POLICIES} listing={listing} onClose={() => {}} onMove={onMove} />
    )
    const view = await mount(ui(LISTING), fakeApi())

    await chooseOption('Parent', 'Notes')
    await view.rerender(ui(LISTING.filter(listed => listed !== NOTES)))
    expect(button('Parent').textContent).toBe('Handbook')
    expect(button('Move').disabled).toBe(true)

    await chooseOption('Parent', 'Roadmap')
    // With its parent gone too, the listing shows the workspace at the top.
    await view.rerender(ui([POLICIES]))
    expect(button('Parent').textContent).toBe('Top of the space')
    expect(onMove).not.toHaveBeenCalled()
  })

  it('holds the dialog open while the move is in flight', async () => {
    const answer = deferred<void>()
    const { onClose } = await render(ONBOARDING, vi.fn<OnMove>(() => answer.promise))

    await chooseOption('Position', 'After Policies')
    await click(button('Move'))
    expect(button('Moving…').disabled).toBe(true)
    expect(button('Parent').hasAttribute('disabled') || button('Parent').getAttribute('aria-disabled') === 'true')
      .toBe(true)
    await pressEscape()
    expect(onClose).not.toHaveBeenCalled()

    await settle()
    answer.resolve()
    await settle()
    // Closing after a move is the caller's.
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Move').disabled).toBe(false)
  })

  it('shows the space’s refusal, and stays open for another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onMove = vi.fn<OnMove>(async () => {
      throw new Error('Only the workspace’s owner or a space admin may move it.')
    })
    const { onClose } = await render(ONBOARDING, onMove)

    await chooseOption('Position', 'After Policies')
    await click(button('Move'))
    await settle()
    expect(alerts()).toEqual(['Only the workspace’s owner or a space admin may move it.'])
    expect(onClose).not.toHaveBeenCalled()
    expect(button('Move').disabled).toBe(false)

    // Choosing again clears it.
    await chooseOption('Position', 'First')
    expect(alerts()).toEqual([])
  })
})
