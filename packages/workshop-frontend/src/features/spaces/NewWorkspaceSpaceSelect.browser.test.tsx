/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { NewWorkspaceSpaceSelect } from './NewWorkspaceSpaceSelect'
import type { SpaceChoice } from './SpaceChoices'
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

const SPACES = [personalSpace(ME), teamSpace('design', 'Design', 'use'), teamSpace('platform', 'Platform')]

// The picker as the screen holds it, starting on the personal space. Platform holds Infra,
// unless the test says which spaces the user has and which of them open with what inside.
const render = async (
  spaces: SpaceInfo[] = SPACES,
  among: (platform: ReturnType<typeof fakeSpace>) => ReturnType<typeof fakeSpace>[] = platform => [platform],
) => {
  const onValueChange = vi.fn<(choice: SpaceChoice | null) => void>()
  const platform = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')], [], {
    subspaces: [subspace('infra', 'Infra')],
  })
  const openSpace = openSpaceAmong(among(platform))
  const Held = () => {
    const [value, setValue] = useState<SpaceChoice | null>(null)
    return (
      <div className="flex justify-end p-10">
        <NewWorkspaceSpaceSelect
          spaces={spaces}
          value={value}
          disabled={false}
          onValueChange={(choice) => { onValueChange(choice); setValue(choice) }}
        />
      </div>
    )
  }
  await mount(<Held />, fakeApi({ openSpace }))
  return { onValueChange, platform }
}

const trigger = (name: string) => page.getByRole('button', { name: `Space: ${name}`, exact: true })
const popup = () => page.getByRole('dialog', { name: 'Space' })
const radio = (name: string) => page.getByRole('radio', { name, exact: true })

// The box of the popup that scrolls the spaces: the group's nearest ancestor that scrolls what
// overflows it.
const scrollingBox = () => {
  let ancestor = document.querySelector('[role="radiogroup"]')!.parentElement
  while (ancestor && getComputedStyle(ancestor).overflowY !== 'auto') ancestor = ancestor.parentElement
  if (!ancestor) throw new Error('Nothing scrolls the spaces')
  return ancestor
}
const rectOf = (element: Element) => element.getBoundingClientRect()

// How far outside the element its focus ring is drawn: the widest spread of its shadows.
const ringWidth = (element: Element) => Math.max(0, ...[
  ...getComputedStyle(element).boxShadow.matchAll(/(?:-?[\d.]+px ){3}(-?[\d.]+)px/g),
].map(shadow => Number(shadow[1])))

const openByKeyboard = async () => {
  await act(async () => { (trigger('Personal').element() as HTMLElement).focus() })
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(popup()).toBeVisible()
}

describe('NewWorkspaceSpaceSelect in a browser', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('opens from the keyboard, chooses with the arrow keys while it stays open, and gives its button the focus back on Escape', async () => {
    const { onValueChange } = await render()
    await openByKeyboard()
    await expect.element(radio('Personal')).toHaveFocus()

    await input(() => userEvent.keyboard('{ArrowDown}'))
    await expect.element(popup()).toBeVisible()
    await expect.element(trigger('Design')).toBeInTheDocument()
    expect(onValueChange).toHaveBeenLastCalledWith({ id: 'design', name: 'Design' })

    await input(() => userEvent.keyboard('{ArrowDown}'))
    await expect.element(popup()).toBeVisible()
    await expect.element(trigger('Platform')).toBeInTheDocument()
    await expect.element(radio('Platform')).toHaveFocus()

    await input(() => userEvent.keyboard('{Escape}'))
    await expect.element(popup()).not.toBeInTheDocument()
    await expect.element(trigger('Platform')).toHaveFocus()
  })

  it('closes on Enter with the space the arrow keys reached chosen, and the focus back on its button', async () => {
    const { onValueChange } = await render()
    await openByKeyboard()

    await input(() => userEvent.keyboard('{ArrowDown}'))
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.element(popup()).not.toBeInTheDocument()
    await expect.element(trigger('Design')).toHaveFocus()
    expect(onValueChange.mock.calls).toEqual([[{ id: 'design', name: 'Design' }]])
    // The Enter that settled on the space did not reach the button and open it again.
    await new Promise(resolve => setTimeout(resolve, 300))
    await expect.element(popup()).not.toBeInTheDocument()
  })

  it('chooses on Enter a space the Tab key reached while the chosen one is not shown, and closes on it', async () => {
    const { onValueChange } = await render()
    await input(() => userEvent.click(trigger('Personal')))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Sub-spaces of Platform', exact: true })))
    await input(() => userEvent.click(radio('Infra')))
    await expect.element(popup()).not.toBeInTheDocument()

    // Opened again, nothing is expanded: Infra is not shown, and no radio is the chosen one.
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(popup()).toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Sub-spaces of Personal', exact: true })).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(radio('Personal')).toHaveFocus()
    await expect.element(radio('Personal')).not.toBeChecked()

    await input(() => userEvent.keyboard('{Enter}'))

    await expect.element(popup()).not.toBeInTheDocument()
    expect(onValueChange).toHaveBeenLastCalledWith(null)
    await expect.element(trigger('Personal')).toHaveFocus()
  })

  it('leaves room in the box that scrolls for the focus ring of a control at its edge', async () => {
    await render()
    await openByKeyboard()
    await input(() => userEvent.tab({ shift: true }))
    const first = page.getByRole('button', { name: 'Sub-spaces of Personal', exact: true })
    await expect.element(first).toHaveFocus()
    await Promise.all(popup().element().getAnimations({ subtree: true }).map(animation => animation.finished))

    const ring = ringWidth(first.element())
    expect(ring).toBeGreaterThan(0)
    // The box clips what is drawn outside it, so the ring has to fit between the button and it.
    const box = scrollingBox()
    expect(rectOf(first.element()).left - rectOf(box).left).toBeGreaterThanOrEqual(ring)
    expect(rectOf(first.element()).top - rectOf(box).top).toBeGreaterThanOrEqual(ring)
  })

  it('closes on a pointer choice, with the focus back on its button', async () => {
    const { onValueChange } = await render()

    await input(() => userEvent.click(trigger('Personal')))
    await expect.element(popup()).toBeVisible()
    await input(() => userEvent.click(radio('Platform')))

    await expect.element(popup()).not.toBeInTheDocument()
    await expect.element(trigger('Platform')).toHaveFocus()
    expect(onValueChange.mock.calls).toEqual([[{ id: 'platform', name: 'Platform' }]])
  })

  it('stays open when a space is expanded, so that a sub-space can be chosen with the next press', async () => {
    const { onValueChange } = await render()
    await input(() => userEvent.click(trigger('Personal')))
    await expect.element(popup()).toBeVisible()

    await input(() => userEvent.click(page.getByRole('button', { name: 'Sub-spaces of Platform', exact: true })))
    await expect.element(radio('Infra')).toBeVisible()
    await expect.element(popup()).toBeVisible()
    expect(onValueChange).not.toHaveBeenCalled()

    await input(() => userEvent.click(radio('Infra')))
    await expect.element(popup()).not.toBeInTheDocument()
    await expect.element(trigger('Infra')).toHaveFocus()
    expect(onValueChange.mock.calls).toEqual([[{ id: 'infra', name: 'Infra' }]])
  })

  it('gives the expand button the focus when another try shows the sub-spaces, and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform } = await render()
    platform.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await input(() => userEvent.click(trigger('Personal')))
    await expect.element(popup()).toBeVisible()
    const expand = page.getByRole('button', { name: 'Sub-spaces of Platform', exact: true })
    await input(() => userEvent.click(expand))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Platform' })
    await expect.element(retry).toBeVisible()

    await input(() => userEvent.click(retry))

    await expect.element(radio('Infra')).toBeVisible()
    await expect.element(expand).toHaveFocus()
    // The popup takes the focus a control drops once more on the frame after: the button keeps it.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await expect.element(expand).toHaveFocus()
    await expect.element(popup()).toBeVisible()
  })

  it('leaves the focus on a Try again that failed again, and stays open', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform } = await render()
    let fail!: (err: Error) => void
    platform.listSubspaces
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    await input(() => userEvent.click(trigger('Personal')))
    await expect.element(popup()).toBeVisible()
    await input(() => userEvent.click(page.getByRole('button', { name: 'Sub-spaces of Platform', exact: true })))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Platform' })
    await expect.element(retry).toBeVisible()

    await input(() => userEvent.click(retry))
    await expect.element(retry).toHaveAttribute('aria-disabled', 'true')
    await act(async () => fail(new Error('boom')))

    await expect.element(retry).not.toHaveAttribute('aria-disabled')
    await expect.element(retry).toHaveFocus()
    // Nothing left the row, so nothing takes the focus on the frame after either.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await expect.element(retry).toHaveFocus()
    await expect.element(popup()).toBeVisible()
    expect(platform.listSubspaces).toHaveBeenCalledTimes(2)
  })

  it('keeps many spaces inside the window, in a box that scrolls to the one the keyboard reaches', async () => {
    await page.viewport(1024, 600)
    await render([
      personalSpace(ME),
      ...Array.from({ length: 40 }, (_, index) => teamSpace(`s${index}`, `Space ${String(index).padStart(2, '0')}`)),
    ])
    await openByKeyboard()
    const dialog = popup().element()
    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
    const box = scrollingBox()
    const last = radio('Space 39').element()

    expect(rectOf(dialog).top).toBeGreaterThanOrEqual(0)
    expect(rectOf(dialog).bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight)
    expect(rectOf(last).top).toBeGreaterThanOrEqual(rectOf(box).bottom)

    // Up from the first space is the last, which the box scrolls to.
    await input(() => userEvent.keyboard('{ArrowUp}'))
    await expect.element(radio('Space 39')).toHaveFocus()
    expect(rectOf(last).top).toBeGreaterThanOrEqual(rectOf(box).top - 1)
    expect(rectOf(last).bottom).toBeLessThanOrEqual(rectOf(box).bottom + 1)
    expect(rectOf(dialog).bottom).toBeLessThanOrEqual(window.innerHeight)
  })

  it('breaks a name too long for its row, at the top and as deep as spaces go, and never scrolls sideways', async () => {
    await page.viewport(1024, 768)
    // Five spaces one inside the other under Platform, the innermost with a name of one word.
    const chain = ['One', 'Two', 'Three', 'Four', 'Infrastructure']
    const unbroken = 'Internationalisation-and-localisation-engineering'
    await render(
      [...SPACES, teamSpace('unbroken', unbroken)],
      () => [
        fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')], [], {
          subspaces: [subspace('level0', chain[0])],
        }),
        ...chain.map((name, level) => fakeSpace(teamSpace(`level${level}`, name), [], [], {
          inherited: 'admin',
          subspaces: level + 1 < chain.length ? [subspace(`level${level + 1}`, chain[level + 1])] : [],
        })),
      ],
    )
    await input(() => userEvent.click(trigger('Personal')))
    await expect.element(popup()).toBeVisible()
    for (const name of ['Platform', ...chain.slice(0, -1)]) {
      await input(() => userEvent.click(page.getByRole('button', { name: `Sub-spaces of ${name}`, exact: true })))
    }
    await expect.element(radio('Infrastructure')).toBeVisible()
    const dialog = popup().element()
    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
    const box = scrollingBox()

    expect(box.scrollWidth).toBe(box.clientWidth)
    for (const name of ['Infrastructure', unbroken]) {
      const label = radio(name).element().closest('label')!
      expect(rectOf(label).left).toBeGreaterThanOrEqual(rectOf(box).left)
      expect(rectOf(label).right).toBeLessThanOrEqual(rectOf(box).right + 1)
      // On more lines than the one a name that fits takes.
      expect(rectOf(label).height).toBeGreaterThan(rectOf(radio('Design').element().closest('label')!).height)
    }
  })
})
