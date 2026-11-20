import { describe, expect, it } from 'vitest'
import { askable, holderOf, PAGE, placeOf } from './accessQuestions'

const gadget = { workspaceId: 'w', gadgetId: 3 }
const workspace = { workspaceId: 'w' }

describe('holderOf', () => {
  it('asks of a gadget only in its own pane', () => {
    expect(holderOf(gadget, [placeOf('w', 3)])).toBe('w/3')
    expect(holderOf(gadget, [placeOf('w', 4), PAGE])).toBeUndefined()
  })

  it('asks of a workspace in any pane of its, else the page, else nowhere', () => {
    expect(holderOf(workspace, [PAGE, placeOf('w', 4)])).toBe('w/4')
    expect(holderOf(workspace, [placeOf('other', 1), PAGE])).toBe(PAGE)
    expect(holderOf(workspace, [placeOf('other', 1)])).toBeUndefined()
  })
})

describe('askable', () => {
  it('leaves a gadget read in the background waiting, asking what can be asked after it', () => {
    expect(askable([gadget, workspace], [PAGE])).toBe(workspace)
    expect(askable([gadget], [PAGE])).toBeUndefined()
  })

  it('asks of the gadget once its pane is shown', () => {
    expect(askable([gadget, workspace], [placeOf('w', 3)])).toBe(gadget)
  })

  it('asks of a workspace even where nothing can, as the whole window', () => {
    expect(askable([workspace], [])).toBe(workspace)
  })
})
