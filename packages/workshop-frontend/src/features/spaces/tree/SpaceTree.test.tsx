// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Toasty } from '@cloudflare/kumo'
import type { SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import { ME, deferred, fakeApi, mount, person, settle, unmountAll } from '../spacesTestUtils'
import { SpaceTree, type SpaceTreeMember } from './SpaceTree'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const GRACE = person('grace@example.com', 'Grace')
const CREATED = new Date('2026-09-01T00:00:00Z')

const entry = (id: string, title: string, fields: Partial<SpaceWorkspaceInfo> = {}): SpaceWorkspaceInfo =>
  ({ id, title, owner: ME, created: CREATED, ...fields })

// In pre-order, as the space lists it:
//   Atlas            (mine, published)
//   ├─ Roadmap       (Grace's, published)
//   └─ Notes         (mine)
//      └─ Drafts     (mine, published, hidden by Notes)
//   Budget           (Grace's)
const LISTING: readonly SpaceWorkspaceInfo[] = [
  entry('atlas', 'Atlas', { position: 0, published: 'use' }),
  entry('roadmap', 'Roadmap', { parentId: 'atlas', position: 0, owner: GRACE, published: 'build' }),
  entry('notes', 'Notes', { parentId: 'atlas', position: 1 }),
  entry('drafts', 'Drafts', { parentId: 'notes', position: 0, published: 'use', hiddenBy: 'notes' }),
  entry('budget', 'Budget', { position: 1, owner: GRACE }),
]

const actions = () => ({
  onNewChild: vi.fn<(entry: SpaceWorkspaceInfo) => void>(),
  onMove: vi.fn<(entry: SpaceWorkspaceInfo) => void>(),
  onChangeAddress: vi.fn<(entry: SpaceWorkspaceInfo) => void>(),
})

const asMember = (
  role: SpaceTreeMember['role'],
  onMove: SpaceTreeMember['onMove'] = async () => {},
) => ({
  role,
  profileId: ME.id,
  onMove: vi.fn<SpaceTreeMember['onMove']>(onMove),
  actions: actions(),
})

type Props = ComponentProps<typeof SpaceTree>

const renderTree = async (props: Partial<Props> = {}) => {
  const all: Props = {
    listing: LISTING,
    label: 'Workspaces in Design',
    onSelect: vi.fn<(id: string) => void>(),
    onOpen: vi.fn<(entry: SpaceWorkspaceInfo) => void>(),
    member: null,
    ...props,
  }
  const ui = (next: Props) => <Toasty><SpaceTree {...next} /></Toasty>
  const view = await mount(ui(all), fakeApi())
  return { ...all, rerender: (next: Partial<Props>) => view.rerender(ui({ ...all, ...next })) }
}

const rowElements = () => [...document.body.querySelectorAll<HTMLElement>('[data-hierarchical-list-row]')]
const titleOf = (row: HTMLElement) => {
  const id = row.closest<HTMLElement>('[data-hierarchical-list-item]')?.dataset.itemId
  return LISTING.find(listed => listed.id === id)?.title
}

/** Every row, top to bottom, as its title indented two spaces per level. */
const outline = () => rowElements().map(row => `${'  '.repeat(Number(row.dataset.depth))}${titleOf(row)}`)

const row = (title: string) => {
  const found = rowElements().find(candidate => titleOf(candidate) === title)
  if (!found) throw new Error(`No row “${title}”`)
  return found
}

const pressAlt = (target: HTMLElement, key: string) => act(async () => {
  target.focus()
  target.dispatchEvent(new KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true }))
})

const announcement = () => [...document.body.querySelectorAll('[role="status"]')]
  .map(status => status.textContent).join('')

const toasts = () => [...document.body.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent)

const openMenu = async (title: string) => {
  await act(async () => {
    row(title).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

// The "More actions" button beside a row, a sibling of the row's own button.
const actionsButton = (title: string) =>
  row(title).parentElement?.querySelector<HTMLButtonElement>(':scope > [data-hierarchical-list-row-actions]') ?? null

const openActions = async (title: string) => {
  await act(async () => {
    actionsButton(title)!.focus()
    actionsButton(title)!.click()
  })
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

const labels = (items: HTMLElement[]) => items.map(item => item.textContent)

const closeMenu = () => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})

// What a row's published indicator says, in full, to assistive technology and in its tooltip.
const publication = (title: string) => row(title).querySelector('[role="img"]')?.getAttribute('aria-label')

const menuItem = async (title: string, label: string) => {
  const found = (await openMenu(title)).find(item => item.textContent === label)
  if (!found) throw new Error(`No “${label}” in the menu of “${title}”`)
  return found
}

const choose = (item: HTMLElement) => act(async () => { item.click() })

describe('SpaceTree', () => {
  it('nests the listing, with what each row says about its publication', async () => {
    await renderTree()

    expect(document.body.querySelector('ul')?.getAttribute('aria-label')).toBe('Workspaces in Design')
    expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', 'Budget'])
    expect(publication('Atlas')).toBe('Published to everyone signed in · can use')
    expect(publication('Roadmap')).toBe('Published to everyone signed in · can build')
    expect(publication('Notes')).toBeUndefined()
    expect(publication('Drafts')).toBe("Published, but not visible until 'Notes' is published")
    // The indicator takes no room in the row's text, which is the workspace's name.
    expect(row('Atlas').textContent).toBe('Atlas')
  })

  it('names an untitled workspace as the rest of the app does', async () => {
    await renderTree({ listing: [entry('blank', '')] })
    expect(rowElements().map(candidate => candidate.textContent)).toEqual(['Untitled Workspace'])
  })

  it('names an untitled workspace that holds back a publication the same way', async () => {
    await renderTree({
      listing: [
        entry('blank', '', { position: 0 }),
        entry('child', 'Child', { parentId: 'blank', position: 0, published: 'build', hiddenBy: 'blank' }),
      ],
    })
    const child = document.body.querySelector('[data-item-id="child"] [data-hierarchical-list-row]')
    expect(child?.querySelector('[role="img"]')?.getAttribute('aria-label'))
      .toBe("Published, but not visible until 'Untitled Workspace' is published")
  })

  it('renders nothing for an empty listing', async () => {
    await renderTree({ listing: [] })
    expect(document.body.querySelector('[data-hierarchical-list-root]')).toBeNull()
  })

  it('selects the entry a row is pressed for, and marks the selected one', async () => {
    const tree = await renderTree()
    await act(async () => { row('Budget').click() })
    expect(tree.onSelect).toHaveBeenCalledWith('budget')

    await tree.rerender({ selectedId: 'budget' })
    expect(row('Budget').getAttribute('aria-current')).toBe('true')
    expect(row('Atlas').hasAttribute('aria-current')).toBe(false)
  })

  it('selects a branch without closing it, and opens and closes the selected one', async () => {
    const tree = await renderTree()
    await act(async () => { row('Notes').click() })
    expect(tree.onSelect).toHaveBeenCalledExactlyOnceWith('notes')
    expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', 'Budget'])

    await tree.rerender({ selectedId: 'notes' })
    await act(async () => { row('Notes').click() })
    expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', 'Budget'])
    expect(row('Notes').getAttribute('aria-expanded')).toBe('false')

    await tree.rerender({ selectedId: 'notes', listing: [...LISTING] })
    expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', 'Budget'])

    await act(async () => { row('Notes').click() })
    expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', 'Budget'])
    // Opening and closing the selected entry selects nothing again.
    expect(tree.onSelect).toHaveBeenCalledOnce()
  })

  it('focuses the row a caller asks for, once for each request', async () => {
    const tree = await renderTree()
    const request = { id: 'drafts' }
    await tree.rerender({ focusRequest: request })
    expect(document.activeElement).toBe(row('Drafts'))

    row('Budget').focus()
    await tree.rerender({ focusRequest: request, listing: [...LISTING] })
    expect(document.activeElement).toBe(row('Budget'))
  })

  describe('moves', () => {
    it('lets a member drag only what the space lets them move', async () => {
      await renderTree({ member: asMember('build') })
      expect(rowElements().filter(candidate => candidate.draggable).map(titleOf))
        .toEqual(['Atlas', 'Notes', 'Drafts'])
    })

    it('lets an admin drag every entry', async () => {
      await renderTree({ member: asMember('admin') })
      expect(rowElements().every(candidate => candidate.draggable)).toBe(true)
    })

    it('shows a keyboard move at once, asks the space for it by its anchor, and announces it', async () => {
      const answer = deferred<void>()
      const member = asMember('admin', () => answer.promise)
      const tree = await renderTree({ member })

      await pressAlt(row('Budget'), 'ArrowUp')

      expect(member.onMove).toHaveBeenCalledExactlyOnceWith('budget', null, 'atlas')
      expect(outline()).toEqual(['Budget', 'Atlas', '  Roadmap', '  Notes', '    Drafts'])
      expect(document.activeElement).toBe(row('Budget'))
      expect(announcement()).toBe('')

      await act(async () => answer.resolve())
      expect(announcement()).toBe('Budget moved to position 1 in Workspaces in Design.')
      // Confirmed, the move stays shown on the listing it was made over.
      expect(outline()).toEqual(['Budget', 'Atlas', '  Roadmap', '  Notes', '    Drafts'])

      // A listing read afterwards is the space's account, which wins.
      await tree.rerender({ listing: [LISTING[4], ...LISTING.slice(0, 4)].map(({ position, ...rest }) => rest) })
      expect(outline()).toEqual(['Budget', 'Atlas', '  Roadmap', '  Notes', '    Drafts'])
      await tree.rerender({ listing: LISTING })
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', 'Budget'])
    })

    it('moves an entry out from under its parent, with the entries under it', async () => {
      const member = asMember('build')
      await renderTree({ member })

      await pressAlt(row('Notes'), 'ArrowLeft')

      expect(member.onMove).toHaveBeenCalledExactlyOnceWith('notes', null, 'budget')
      expect(outline()).toEqual(['Atlas', '  Roadmap', 'Notes', '  Drafts', 'Budget'])
    })

    it('says when a move takes a published entry under an unpublished one', async () => {
      await renderTree({ member: asMember('admin') })

      await pressAlt(row('Roadmap'), 'ArrowDown')
      await pressAlt(row('Roadmap'), 'ArrowRight')

      expect(outline()).toEqual(['Atlas', '  Notes', '    Drafts', '    Roadmap', 'Budget'])
      expect(publication('Roadmap')).toBe("Published, but not visible until 'Notes' is published")
    })

    it('opens a closed branch an entry is moved into, keeping the entry in view and focused', async () => {
      const member = asMember('admin')
      await renderTree({ member, selectedId: 'atlas' })
      await act(async () => { row('Atlas').click() })
      expect(outline()).toEqual(['Atlas', 'Budget'])

      await pressAlt(row('Budget'), 'ArrowRight')

      expect(member.onMove).toHaveBeenCalledExactlyOnceWith('budget', 'atlas', undefined)
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', '  Budget'])
      expect(document.activeElement).toBe(row('Budget'))
    })

    it('puts the entry back and says so when the space refuses the move', async () => {
      const refusal = deferred<void>()
      const member = asMember('admin', () => refusal.promise.then(() => {
        throw new Error('No such parent workspace in this space.')
      }))
      vi.spyOn(console, 'error').mockImplementation(() => {})
      await renderTree({ member })

      await pressAlt(row('Budget'), 'ArrowRight')
      expect(member.onMove).toHaveBeenCalledExactlyOnceWith('budget', 'atlas', undefined)
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', '  Budget'])

      await act(async () => refusal.resolve())
      await settle()

      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '    Drafts', 'Budget'])
      expect(toasts()).toEqual([expect.stringContaining("Couldn't move Budget")])
      expect(toasts()[0]).toContain('No such parent workspace in this space.')
      expect(announcement()).toBe('')
      // Put back under its old parent, the entry has a new row, which keeps the focus.
      expect(document.activeElement).toBe(row('Budget'))
    })

    it('undoes only the refused move of several in flight', async () => {
      const first = deferred<void>()
      const second = deferred<void>()
      const answers = [
        first.promise.then(() => { throw new Error('Refused.') }),
        second.promise,
      ]
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const member = asMember('admin', () => answers.shift()!)
      await renderTree({ member })

      await pressAlt(row('Budget'), 'ArrowUp')
      await pressAlt(row('Drafts'), 'ArrowLeft')
      expect(outline()).toEqual(['Budget', 'Atlas', '  Roadmap', '  Notes', '  Drafts'])

      await act(async () => first.resolve())
      await settle()
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '  Drafts', 'Budget'])

      await act(async () => second.resolve())
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', '  Drafts', 'Budget'])
    })

    it('moves a dragged entry under the row it is dropped on', async () => {
      const member = asMember('build')
      await renderTree({ member })
      const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: () => {} }
      const drag = (target: HTMLElement, type: string, clientY = 0) => act(async () => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
        Object.defineProperty(event, 'dataTransfer', { value: transfer })
        target.dispatchEvent(event)
      })
      const budget = row('Budget')
      budget.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 200, width: 400, height: 40 })

      await drag(row('Drafts'), 'dragstart')
      await drag(budget, 'dragover', 220)
      await drag(budget, 'drop', 220)

      expect(member.onMove).toHaveBeenCalledExactlyOnceWith('drafts', 'budget', undefined)
      expect(outline()).toEqual(['Atlas', '  Roadmap', '  Notes', 'Budget', '  Drafts'])
    })
  })

  describe('menus', () => {
    it('offers a member what they may do with each entry, and passes it the entry', async () => {
      const tree = await renderTree({ member: asMember('build') })
      const member = tree.member!

      expect(labels(await openMenu('Atlas'))).toEqual(['Open', 'New child workspace', 'Move…', 'Change address'])
      await choose(await menuItem('Atlas', 'Move…'))
      expect(member.actions.onMove).toHaveBeenCalledExactlyOnceWith(LISTING[0])

      expect(labels(await openMenu('Roadmap'))).toEqual(['Open', 'New child workspace'])
      await choose(await menuItem('Roadmap', 'New child workspace'))
      expect(member.actions.onNewChild).toHaveBeenCalledExactlyOnceWith(LISTING[1])

      await choose(await menuItem('Notes', 'Change address'))
      expect(member.actions.onChangeAddress).toHaveBeenCalledExactlyOnceWith(LISTING[2])
      await choose(await menuItem('Budget', 'Open'))
      expect(tree.onOpen).toHaveBeenCalledExactlyOnceWith(LISTING[4])
    })

    it('offers an admin moves and addresses of every entry', async () => {
      await renderTree({ member: asMember('admin') })
      expect(labels(await openMenu('Roadmap'))).toEqual(['Open', 'New child workspace', 'Move…', 'Change address'])
    })

    it('adds Share and Re-sync from source where the caller offers them for the entry', async () => {
      const onShare = vi.fn<() => void>()
      const onResync = vi.fn<() => void>()
      const entryActions = vi.fn<NonNullable<Props['entryActions']>>(listed => ({
        ...(listed.id === 'atlas' && { onShare, onResync }),
        ...(listed.id === 'roadmap' && { onShare }),
      }))
      await renderTree({ member: asMember('build'), entryActions })

      expect(labels(await openMenu('Atlas')))
        .toEqual(['Open', 'New child workspace', 'Move…', 'Change address', 'Share', 'Re-sync from source'])
      expect(entryActions).toHaveBeenCalledWith(LISTING[0])
      await choose(await menuItem('Atlas', 'Re-sync from source'))
      expect(onResync).toHaveBeenCalledOnce()
      await choose(await menuItem('Roadmap', 'Share'))
      expect(onShare).toHaveBeenCalledOnce()
      expect(labels(await openMenu('Budget'))).toEqual(['Open', 'New child workspace'])
    })

    it('opens the same menu from each row’s "More actions" button, which sits beside the row', async () => {
      await renderTree({ member: asMember('build'), entryActions: () => ({ onShare: vi.fn<() => void>() }) })

      for (const { title } of LISTING) {
        const trigger = actionsButton(title)
        expect(trigger?.getAttribute('aria-label')).toBe(`More actions for ${title}`)
        expect(row(title).contains(trigger)).toBe(false)
      }
      const fromRow = labels(await openMenu('Notes'))
      await closeMenu()
      expect(labels(await openActions('Notes'))).toEqual(fromRow)
      expect(fromRow).toEqual(['Open', 'New child workspace', 'Move…', 'Change address', 'Share'])
    })

    it('names the button of an untitled workspace as its row is named', async () => {
      await renderTree({ listing: [entry('blank', '')] })
      expect(document.body.querySelector('[data-hierarchical-list-row-actions]')?.getAttribute('aria-label'))
        .toBe('More actions for Untitled Workspace')
    })
  })

  describe('for a visitor', () => {
    it('is read-only: nothing to drag or move by keyboard, and only Open in the menu', async () => {
      const tree = await renderTree({ listing: LISTING.slice(0, 2) })

      expect(rowElements().some(candidate => candidate.draggable)).toBe(false)
      expect(row('Roadmap').hasAttribute('aria-keyshortcuts')).toBe(false)
      await pressAlt(row('Roadmap'), 'ArrowLeft')
      expect(outline()).toEqual(['Atlas', '  Roadmap'])

      expect(labels(await openMenu('Roadmap'))).toEqual(['Open'])
      await choose(await menuItem('Roadmap', 'Open'))
      expect(tree.onOpen).toHaveBeenCalledExactlyOnceWith(LISTING[1])
    })

    it('has a "More actions" button on every row all the same, offering Open and what the caller adds', async () => {
      const tree = await renderTree({
        listing: LISTING.slice(0, 2),
        entryActions: listed => (listed.id === 'roadmap' ? { onShare: vi.fn<() => void>() } : {}),
      })

      expect(labels(await openActions('Atlas'))).toEqual(['Open'])
      await choose([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')][0]!)
      expect(tree.onOpen).toHaveBeenCalledExactlyOnceWith(LISTING[0])
      expect(labels(await openActions('Roadmap'))).toEqual(['Open', 'Share'])
    })
  })
})
