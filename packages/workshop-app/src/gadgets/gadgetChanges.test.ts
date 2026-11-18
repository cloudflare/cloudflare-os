import { describe, expect, it, vi } from 'vitest'
import { deleteGadget, renameGadget, titleAfter, type ChangedGadget, type ChangingOverseer } from './gadgetChanges'

const fakeWorkspace = (refusal?: Error) => {
  const order: string[] = []
  const gadget: ChangedGadget = {
    setTitle: vi.fn<ChangedGadget['setTitle']>(async () => {
      if (refusal) throw refusal
    }),
    remove: vi.fn<ChangedGadget['remove']>(async () => {
      if (refusal) throw refusal
    }),
    [Symbol.dispose]: () => void order.push('gadget'),
  }
  const overseer: ChangingOverseer = {
    getGadget: vi.fn<ChangingOverseer['getGadget']>(() => gadget),
    [Symbol.dispose]: () => void order.push('workspace'),
  }
  return { gadget, overseer, order }
}

describe('renameGadget and deleteGadget', () => {
  it('change the gadget asked for, then let go of it and its workspace', async () => {
    const { gadget, overseer, order } = fakeWorkspace()
    await renameGadget(() => overseer, 7, 'Today')
    expect(overseer.getGadget).toHaveBeenCalledWith(7)
    expect(gadget.setTitle).toHaveBeenCalledWith('Today')
    expect(order).toEqual(['gadget', 'workspace'])

    await deleteGadget(() => overseer, 7)
    expect(gadget.remove).toHaveBeenCalledOnce()
    expect(order).toEqual(['gadget', 'workspace', 'gadget', 'workspace'])
  })

  it('let go of them when it is refused too, rejecting with why', async () => {
    const { overseer, order } = fakeWorkspace(new Error('Only builders can delete'))
    await expect(deleteGadget(() => overseer, 7)).rejects.toThrow('Only builders can delete')
    expect(order).toEqual(['gadget', 'workspace'])
  })
})

describe('titleAfter', () => {
  it('shows the new title while the old one is still read, and whatever is read after that', () => {
    const renamed = { from: 'Q3 review', to: 'Q3 platform review' }
    expect(titleAfter('Q3 review', renamed)).toBe('Q3 platform review')
    expect(titleAfter('Q3 platform review', renamed)).toBe('Q3 platform review')
    // Renamed again since, by someone else.
    expect(titleAfter('Quarterly review', renamed)).toBe('Quarterly review')
    expect(titleAfter('Q3 review', undefined)).toBe('Q3 review')
  })
})
