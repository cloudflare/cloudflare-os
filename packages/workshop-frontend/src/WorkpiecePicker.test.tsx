// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeSummary } from '@gadgets/workshop-shared/api'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import WorkpiecePicker from './WorkpiecePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const GADGETS: GadgetSummary[] = [
  { id: 1, type: 'gadget', title: 'Hooked' },
  { id: 2, type: 'gadget', title: 'Ordinary' },
]

// `role="img"` is what makes the label reachable; a bare span would be named nothing.
const HOOK_BADGE = '[role="img"][aria-label="Hooks enabled"]'

// Right-clicks `target` and picks Delete from the menu that opens.
const chooseDelete = async (target: Element) => {
  act(() => {
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const item = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(menuItem => menuItem.textContent === 'Delete')!
  await act(async () => item.click())
}

describe('WorkpiecePicker', () => {
  let root: Root | undefined
  let host: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = undefined
    host = undefined
  })

  async function render({
    expanded = true,
    onDelete = vi.fn<(gadget: GadgetSummary) => void>(),
  }: {
    expanded?: boolean
    onDelete?: (gadget: GadgetSummary) => void
  } = {}) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () => root!.render(
      <WorkpiecePicker
        gadgets={GADGETS}
        worktrees={[]}
        selectedId={null}
        expanded={expanded}
        hookedGadgetIds={new Set([1])}
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
        onSelect={vi.fn<(id: number) => void>()}
        onRename={vi.fn<(id: number, title: string) => void>()}
        onDelete={onDelete}
        pendingActivityCount={0}
        onOpenActivity={vi.fn<() => void>()}
      />,
    ))
    return host
  }

  const rowButton = (title: string) => [...host!.querySelectorAll('button')]
    .find(button => button.textContent?.includes(title))!

  it('names the badge only on gadgets with an enabled hook', async () => {
    const container = await render()
    const labelled = container.querySelectorAll(HOOK_BADGE)

    expect(labelled).toHaveLength(1)
    expect(labelled[0].closest('button')?.textContent).toContain('Hooked')
  })

  it('keeps the badge named when collapsed, where no title is rendered', async () => {
    const container = await render({ expanded: false })

    expect(container.textContent).not.toContain('Hooked')
    expect(container.querySelectorAll(HOOK_BADGE)).toHaveLength(1)
  })

  it('asks to delete a gadget from its right-click menu', async () => {
    const onDelete = vi.fn<(gadget: GadgetSummary) => void>()
    await render({ onDelete })

    await chooseDelete(rowButton('Ordinary'))

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(GADGETS[1])
  })

  it('offers the menu on the collapsed rail too', async () => {
    const onDelete = vi.fn<(gadget: GadgetSummary) => void>()
    const container = await render({ expanded: false, onDelete })

    // Collapsed rows show no title; find the row by its badge instead.
    await chooseDelete(container.querySelector(HOOK_BADGE)!)

    expect(onDelete).toHaveBeenCalledExactlyOnceWith(GADGETS[0])
  })
})

describe('WorkpiecePicker grouped panel', () => {
  let root: Root | undefined
  afterEach(async () => {
    await act(async () => root?.unmount())
    window.localStorage.clear()
  })

  const GADGETS = [
    { id: 1, type: 'gadget' as const, title: 'Report · Test · Tidewater Covenants · Monthly' },
    { id: 2, type: 'gadget' as const, title: 'Receipts Hold' },
    { id: 3, type: 'gadget' as const, title: 'Dashboard · Monitor · Debt Maturities · Daily' },
    { id: 4, type: 'gadget' as const, title: 'Report · Test · Bridge Covenants · Monthly' },
  ]

  async function render(props: {
    selectedId?: number | null
    onMoveGadget?: (move: { id: number; targetId: number; placement: 'before' | 'after' }) => void
    onWidthChange?: (width: number) => void
    workspaceId?: string
  } = {}) {
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkpiecePicker
        workspaceId={props.workspaceId ?? 'ws-1'}
        gadgets={GADGETS}
        worktrees={[{ id: 9, type: 'worktree', title: 'scratch', chatId: 1 } as WorktreeSummary]}
        selectedId={props.selectedId ?? null}
        expanded
        hookedGadgetIds={new Set([1])}
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
        width={300}
        onWidthChange={props.onWidthChange}
        onSelect={vi.fn<(id: number) => void>()}
        onRename={vi.fn<(id: number, title: string) => void>()}
        onMoveGadget={props.onMoveGadget}
        pendingActivityCount={0}
        onOpenActivity={vi.fn<() => void>()}
      />,
    ))
    return container
  }

  const sections = (c: HTMLElement) => [...c.querySelectorAll('section')].map(s => s.getAttribute('aria-label'))
  const rowTitles = (c: HTMLElement) =>
    [...c.querySelectorAll<HTMLButtonElement>('button[title]')]
      .map(b => b.title).filter(t => t !== 'Collapse outputs' && t !== 'Rename gadget')
  const groupToggle = (c: HTMLElement, name: string) =>
    c.querySelector<HTMLButtonElement>(`section[aria-label="${name}"] > button`)!

  async function search(c: HTMLElement, value: string) {
    const input = c.querySelector<HTMLInputElement>('input[type="search"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('groups rows by category with Contents first and Action · Cadence second', async () => {
    const c = await render()
    expect(sections(c)).toEqual(['Dashboard', 'Report', 'Other'])
    expect(rowTitles(c)).toEqual([
      'Dashboard · Monitor · Debt Maturities · Daily',
      'Report · Test · Tidewater Covenants · Monthly',
      'Report · Test · Bridge Covenants · Monthly',
      'Receipts Hold',
      'scratch',
    ])
    const row = c.querySelector<HTMLButtonElement>('button[title="Report · Test · Tidewater Covenants · Monthly"]')!
    const [primary, secondary] = row.querySelectorAll('span.flex-col > span')
    expect(primary.textContent).toBe('Tidewater Covenants')
    expect(primary.className).toContain('font-medium')
    expect(primary.className).not.toContain('truncate')
    expect(secondary.textContent).toBe('Test · Monthly')
    // The hook badge survives the new layout.
    expect(row.querySelector('[aria-label="Hooks enabled"]')).not.toBeNull()
  })

  it('marks the selected row with aria-current', async () => {
    const c = await render({ selectedId: 4 })
    const current = c.querySelectorAll<HTMLButtonElement>('[aria-current="true"]')
    expect(current).toHaveLength(1)
    expect(current[0].title).toBe('Report · Test · Bridge Covenants · Monthly')
  })

  it('filters on the full title and shows matches inside collapsed groups', async () => {
    const c = await render()
    await act(async () => groupToggle(c, 'Report').click())
    expect(rowTitles(c)).not.toContain('Report · Test · Bridge Covenants · Monthly')
    await search(c, 'covenants')
    expect(sections(c)).toEqual(['Report'])
    expect(rowTitles(c)).toEqual([
      'Report · Test · Tidewater Covenants · Monthly',
      'Report · Test · Bridge Covenants · Monthly',
    ])
    await search(c, 'zzz')
    expect(c.textContent).toContain('No matching outputs')
  })

  it('persists collapsed groups per workspace', async () => {
    let c = await render()
    await act(async () => groupToggle(c, 'Report').click())
    expect(groupToggle(c, 'Report').getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(window.localStorage.getItem('gadgets:workshop:outputGroupsCollapsed:ws-1')!))
      .toEqual(['Report'])

    await act(async () => root!.unmount())
    c = await render()
    expect(groupToggle(c, 'Report').getAttribute('aria-expanded')).toBe('false')
    expect(rowTitles(c)).not.toContain('Report · Test · Tidewater Covenants · Monthly')

    await act(async () => root!.unmount())
    c = await render({ workspaceId: 'ws-2' })
    expect(groupToggle(c, 'Report').getAttribute('aria-expanded')).toBe('true')
  })

  it('reorders only within a group', async () => {
    const onMove = vi.fn<(move: GadgetMoveArg) => void>()
    const c = await render({ onMoveGadget: onMove })
    const row = (title: string) =>
      c.querySelector<HTMLButtonElement>(`button[title="${title}"]`)!
    const alt = async (el: Element, k: string) => act(async () => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, altKey: true, bubbles: true }))
    })
    await alt(row('Report · Test · Bridge Covenants · Monthly'), 'ArrowUp')
    expect(onMove).toHaveBeenLastCalledWith({ id: 4, targetId: 1, placement: 'before' })
    // Up from the first Report row would cross into Dashboard: ignored.
    await alt(row('Report · Test · Tidewater Covenants · Monthly'), 'ArrowUp')
    expect(onMove).toHaveBeenCalledTimes(1)
    // No reordering while a search narrows the list.
    await search(c, 'report')
    expect(c.querySelectorAll('[draggable="true"]')).toHaveLength(0)
  })

  it('resizes from the left edge within 240-520px', async () => {
    const onWidthChange = vi.fn<(width: number) => void>()
    const c = await render({ onWidthChange })
    const handle = c.querySelector<HTMLElement>('[role="separator"]')!
    expect(handle.getAttribute('aria-valuenow')).toBe('300')
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenLastCalledWith(316)
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenLastCalledWith(520)
    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    expect(onWidthChange).toHaveBeenLastCalledWith(240)
  })

  it('focuses the search box on Cmd+K', async () => {
    const c = await render()
    document.body.appendChild(c)
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    })
    expect(document.activeElement).toBe(c.querySelector('input[type="search"]'))
    c.remove()
  })
})

type GadgetMoveArg = { id: number; targetId: number; placement: 'before' | 'after' }
