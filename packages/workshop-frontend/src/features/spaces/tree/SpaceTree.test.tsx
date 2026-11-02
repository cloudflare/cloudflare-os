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
  onShare: vi.fn<(entry: SpaceWorkspaceInfo) => void>(),
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
// A row's text runs on into what it says about its publication, so its entry is found by id.
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
    expect(row('Atlas').textContent).toContain('Published · Can use')
    expect(row('Atlas').textContent).not.toContain('Not visible')
    expect(row('Roadmap').textContent).toContain('Published · Can build')
    expect(row('Notes').textContent).not.toContain('Published')
    expect(row('Drafts').textContent).toContain("Not visible to others until 'Notes' is published")
    expect(row('Drafts').textContent).toContain('Published · Can use')
  })

  it('fits the note into the row as a short badge, its tooltip and accessible text saying it in full', async () => {
    await renderTree()

    const badge = row('Drafts').querySelector<HTMLElement>('[title]')
    expect(badge?.title).toBe("Not visible to others until 'Notes' is published")
    expect(badge?.querySelector('[aria-hidden="true"]')?.textContent).toBe('Not visible yet')
    expect(badge?.querySelector('.sr-only')?.textContent)
      .toBe("Published · Can use. Not visible to others until 'Notes' is published")
    expect(row('Atlas').querySelector('[title]')).toBeNull()
  })

  it('names an untitled workspace as the rest of the app does', async () => {
    await renderTree({ listing: [entry('blank', '')] })
    expect(rowElements().map(candidate => candidate.textContent)).toEqual(['Untitled Workspace'])
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
      expect(row('Roadmap').textContent).toContain("Not visible to others until 'Notes' is published")
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

      expect((await openMenu('Atlas')).map(item => item.textContent))
        .toEqual(['Open', 'New child workspace', 'Move…', 'Change address', 'Share'])
      await choose(await menuItem('Atlas', 'Move…'))
      expect(member.actions.onMove).toHaveBeenCalledExactlyOnceWith(LISTING[0])

      expect((await openMenu('Roadmap')).map(item => item.textContent))
        .toEqual(['Open', 'New child workspace'])
      await choose(await menuItem('Roadmap', 'New child workspace'))
      expect(member.actions.onNewChild).toHaveBeenCalledExactlyOnceWith(LISTING[1])

      await choose(await menuItem('Notes', 'Change address'))
      expect(member.actions.onChangeAddress).toHaveBeenCalledExactlyOnceWith(LISTING[2])
      await choose(await menuItem('Notes', 'Share'))
      expect(member.actions.onShare).toHaveBeenCalledExactlyOnceWith(LISTING[2])
      await choose(await menuItem('Budget', 'Open'))
      expect(tree.onOpen).toHaveBeenCalledExactlyOnceWith(LISTING[4])
    })

    it('offers an admin moves and addresses of every entry, but not the sharing of another’s', async () => {
      await renderTree({ member: asMember('admin') })
      expect((await openMenu('Roadmap')).map(item => item.textContent))
        .toEqual(['Open', 'New child workspace', 'Move…', 'Change address'])
    })
  })

  describe('for a visitor', () => {
    it('is read-only: nothing to drag or move by keyboard, and only Open in the menu', async () => {
      const tree = await renderTree({ listing: LISTING.slice(0, 2) })

      expect(rowElements().some(candidate => candidate.draggable)).toBe(false)
      expect(row('Roadmap').hasAttribute('aria-keyshortcuts')).toBe(false)
      await pressAlt(row('Roadmap'), 'ArrowLeft')
      expect(outline()).toEqual(['Atlas', '  Roadmap'])

      expect((await openMenu('Roadmap')).map(item => item.textContent)).toEqual(['Open'])
      await choose(await menuItem('Roadmap', 'Open'))
      expect(tree.onOpen).toHaveBeenCalledExactlyOnceWith(LISTING[1])
    })
  })
})
