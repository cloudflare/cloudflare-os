// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import type { GadgetSummary, WorkpieceId, WorktreeSummary } from '@gadgets/workshop-shared/api'
import {
  closedWorkspaceView,
  getStoredWorkspaceView,
  openedWorkspaceView,
  persistWorkspaceView,
  selectWorkpiece,
  type WorkspaceView,
} from './workspaceView'

const gadget = (id: number, chatId?: number) => ({ type: 'gadget', id, title: `G${id}`, chatId }) as GadgetSummary
const worktree = (id: number, chatId: number) => ({ type: 'worktree', id, chatId }) as unknown as WorktreeSummary
const budget = gadget(1)
const trips = gadget(2)
const notes = gadget(3)

// A workspace whose default is `budget`, with no chat selected.
const select = (view: WorkspaceView | null, options: {
  urlWorkpieceId?: WorkpieceId
  gadgets?: GadgetSummary[]
  worktrees?: WorktreeSummary[]
  defaultGadgetId?: WorkpieceId
} = {}) => {
  const gadgets = options.gadgets ?? [budget, trips, notes]
  return selectWorkpiece({
    urlWorkpieceId: options.urlWorkpieceId ?? null,
    view,
    visibleWorkpieces: [...gadgets, ...(options.worktrees ?? [])],
    visibleGadgets: gadgets,
    defaultGadgetId: 'defaultGadgetId' in options ? options.defaultGadgetId : budget.id,
  })
}

describe('selectWorkpiece', () => {
  it('prefers the URL, then the view, then the default, then the first visible', () => {
    const open: WorkspaceView = { mode: 'app', appId: trips.id }
    expect(select(open, { urlWorkpieceId: notes.id })).toBe(notes.id)
    expect(select(open)).toBe(trips.id)
    expect(select(null)).toBe(budget.id)
    expect(select(null, { defaultGadgetId: undefined, gadgets: [notes, trips] })).toBe(notes.id)
    expect(select(null, { gadgets: [] })).toBeNull()
  })

  it('honours the workpiece a closed pane or the activity view remembers, as an open one', () => {
    expect(select({ mode: 'chat', appId: trips.id })).toBe(trips.id)
    expect(select({ mode: 'activity', appId: trips.id })).toBe(trips.id)
    expect(select({ mode: 'chat', appId: trips.id }, { urlWorkpieceId: notes.id })).toBe(notes.id)
    // A pane closed with nothing remembered, as one loaded from storage.
    expect(select({ mode: 'chat' })).toBe(budget.id)
  })

  it('remembers a worktree the selected chat can show', () => {
    expect(select({ mode: 'chat', appId: 9 }, { worktrees: [worktree(9, 4)] })).toBe(9)
  })

  it('falls through when what the URL or view names is not visible', () => {
    // Deleted, or a draft pending in another chat, which the caller leaves out of the visible lists.
    expect(select({ mode: 'chat', appId: 42 })).toBe(budget.id)
    expect(select({ mode: 'app', appId: 42 }, { urlWorkpieceId: 43 })).toBe(budget.id)
    expect(select({ mode: 'chat', appId: 42 }, { gadgets: [notes, trips] })).toBe(notes.id)
    // The default too.
    expect(select(null, { gadgets: [trips, notes] })).toBe(trips.id)
  })
})

describe('closing and reopening the pane', () => {
  it('keeps the workpiece it showed selected, closed and reopened with none named', () => {
    const open: WorkspaceView = { mode: 'app', appId: trips.id }
    const closed = closedWorkspaceView(select(open))
    expect(closed).toStrictEqual({ mode: 'chat', appId: trips.id })
    expect(select(closed)).toBe(trips.id)
    const reopened = openedWorkspaceView(closed)
    expect(reopened).toStrictEqual({ mode: 'app', appId: trips.id })
    expect(select(reopened)).toBe(trips.id)
  })

  it('keeps a selection the URL made, once the URL no longer makes it', () => {
    const closed = closedWorkspaceView(select({ mode: 'app', appId: trips.id }, { urlWorkpieceId: notes.id }))
    expect(select(closed)).toBe(notes.id)
  })

  it('opens on a named workpiece over the remembered one', () => {
    expect(openedWorkspaceView({ mode: 'chat', appId: trips.id }, notes.id)).toStrictEqual({ mode: 'app', appId: notes.id })
  })

  it('remembers nothing when nothing was selected, and reopens to the legacy form', () => {
    expect(closedWorkspaceView(null)).toStrictEqual({ mode: 'chat' })
    expect(openedWorkspaceView(null)).toStrictEqual({ mode: 'app', appId: undefined })
  })
})

describe('persisting the view', () => {
  beforeEach(() => window.localStorage.clear())

  it('stores a closed pane without the workpiece it remembers', () => {
    persistWorkspaceView('ws', closedWorkspaceView(trips.id))
    expect(window.localStorage.getItem('gadgets:workshop:workspaceVisibility:ws')).toBe('{"mode":"chat"}')
    expect(getStoredWorkspaceView('ws')).toStrictEqual({ mode: 'chat' })
  })

  it('stores an open pane with its workpiece', () => {
    persistWorkspaceView('ws', { mode: 'app', appId: trips.id })
    expect(getStoredWorkspaceView('ws')).toStrictEqual({ mode: 'app', appId: trips.id })
  })

  it('ignores a remembered workpiece written to storage by hand', () => {
    window.localStorage.setItem('gadgets:workshop:workspaceVisibility:ws', '{"mode":"chat","appId":2}')
    expect(getStoredWorkspaceView('ws')).toStrictEqual({ mode: 'chat' })
  })
})
