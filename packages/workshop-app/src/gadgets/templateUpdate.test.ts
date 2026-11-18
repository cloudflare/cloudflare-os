import { describe, expect, it, vi } from 'vitest'
import type { ApplyBlueprintResult } from '@gadgets/workshop-shared/api'
import { proposeTemplateUpdate, templateUpdateStatus, type UpdateOverseer } from './templateUpdate'

describe('templateUpdateStatus', () => {
  it('says an update is there once the template has a release the gadget has not taken', () => {
    expect(templateUpdateStatus({ blueprintId: 'tip-jar', commitId: 'a' }, { version: 3, commitId: 'b' })).toBe('available')
    expect(templateUpdateStatus({ blueprintId: 'tip-jar', commitId: 'b' }, { version: 3, commitId: 'b' })).toBe('upToDate')
  })

  it('says nothing where either side names no release, or nothing is known yet', () => {
    expect(templateUpdateStatus({ blueprintId: 'tip-jar' }, { version: 3, commitId: 'b' })).toBeUndefined()
    expect(templateUpdateStatus({ blueprintId: 'tip-jar', commitId: 'a' }, { version: 3 })).toBeUndefined()
    expect(templateUpdateStatus(undefined, { version: 3, commitId: 'b' })).toBeUndefined()
    expect(templateUpdateStatus({ blueprintId: 'tip-jar', commitId: 'a' }, undefined)).toBeUndefined()
  })
})

type Gadget = ReturnType<UpdateOverseer['getGadget']>

const fakeWorkspace = (apply: () => Promise<ApplyBlueprintResult>) => {
  const gadget = { applyBlueprint: vi.fn<Gadget['applyBlueprint']>(apply), [Symbol.dispose]: vi.fn<() => void>() }
  const overseer = { getGadget: vi.fn<(id: number) => Gadget>(() => gadget), [Symbol.dispose]: vi.fn<() => void>() } satisfies UpdateOverseer
  return { gadget, overseer }
}

describe('proposeTemplateUpdate', () => {
  it('asks the gadget, with the reviewer chosen, and lets the workspace go after', async () => {
    const { gadget, overseer } = fakeWorkspace(async () => ({ outcome: 'proposed', chatId: 12 }))
    await expect(proposeTemplateUpdate(() => overseer, 7, 'tip-jar', { reviewer: 'sonnet' })).resolves.toEqual({ outcome: 'proposed', chatId: 12 })
    expect(overseer.getGadget).toHaveBeenCalledWith(7)
    expect(gadget.applyBlueprint).toHaveBeenCalledWith('tip-jar', { modelId: 'sonnet' })
    expect(gadget[Symbol.dispose]).toHaveBeenCalled()
    expect(overseer[Symbol.dispose]).toHaveBeenCalled()
  })

  it('merges into a gadget of no shared history only once asked to', async () => {
    const { gadget, overseer } = fakeWorkspace(async () => ({ outcome: 'unrelated' }))
    await expect(proposeTemplateUpdate(() => overseer, 7, 'tip-jar', { reviewer: null })).resolves.toEqual({ outcome: 'unrelated' })
    await proposeTemplateUpdate(() => overseer, 7, 'tip-jar', { reviewer: null, allowUnrelated: true })
    expect(gadget.applyBlueprint).toHaveBeenLastCalledWith('tip-jar', { modelId: null, allowUnrelated: true })
  })

  it('says what the server said when it could not be asked, and still lets the workspace go', async () => {
    const { overseer } = fakeWorkspace(() => Promise.reject(new Error('The gadget changed while the update was being prepared.')))
    await expect(proposeTemplateUpdate(() => overseer, 7, 'tip-jar', { reviewer: null })).resolves.toEqual({
      outcome: 'failed',
      message: 'The gadget changed while the update was being prepared.',
    })
    expect(overseer[Symbol.dispose]).toHaveBeenCalled()

    const silent = fakeWorkspace(() => Promise.reject(new Error('')))
    await expect(proposeTemplateUpdate(() => silent.overseer, 7, 'tip-jar', { reviewer: null })).resolves.toEqual({
      outcome: 'failed',
      message: 'Something went wrong while preparing the update.',
    })
  })
})
