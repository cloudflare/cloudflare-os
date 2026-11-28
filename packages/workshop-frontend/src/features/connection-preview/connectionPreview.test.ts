import { expect, it } from 'vitest'
import { previewAt, previewKey, type ConnectionPreview, type PreviewOffer } from './connectionPreview'

const DOC: ConnectionPreview = { gatekeeperId: 7, title: 'Plan', url: 'https://docs.example/plan' }
const FILE: ConnectionPreview = {
  gatekeeperId: 8, item: 'docs:folder/file', title: 'Budget', connectionTitle: 'Finance',
}
const focus = (gadgetId: number, anchor?: string) => ({
  gadgetId, gadgetTitle: 'Finance', ...anchor !== undefined && { spot: { anchor, label: 'Costs' } },
})
// What the connection offers of itself: a preview of its own, none, or no answer. A Google Drive
// connection offers none (its describe() reports no `hasGadgetUi`): each file's preview is one
// of its actions' `previewOf`.
const offers = (offer?: PreviewOffer) => async () => offer
const gone = async () => { throw new Error('gone') }

it('opens the preview with changes waiting that a focus was on', async () => {
  const pending = [DOC, FILE, { ...FILE, item: 'docs:other' }]
  expect(await previewAt(focus(7), pending, gone)).toBe(DOC)
  expect(await previewAt(focus(7, '?tab=t.1#heading=h.costs'), pending, gone)).toBe(DOC)
  expect(await previewAt(focus(8, 'docs:folder/file'), pending, gone)).toBe(FILE)
  expect(await previewAt(focus(8, 'docs:folder/file ?tab=t.1'), pending, gone)).toBe(FILE)
})

it('tells a preview with none from what its connection offers', async () => {
  // A connection with a preview of its own is drawn whole, wherever the spot is.
  expect(await previewAt(focus(7, '?tab=t.1'), [], offers({ url: DOC.url }))).toEqual(
    { gatekeeperId: 7, title: 'Finance', url: DOC.url })
  // One with none draws the item its anchor starts with, under the only title the message kept.
  expect(await previewAt(focus(8, 'docs:folder/file ?tab=t.1'), [{ ...FILE, item: 'docs:other' }], offers()))
    .toEqual({ gatekeeperId: 8, item: 'docs:folder/file', title: 'Finance' })
  expect(await previewAt(focus(8), [FILE], offers())).toBeUndefined()
  await expect(previewAt(focus(8, 'docs:folder/file'), [], gone)).rejects.toThrow('gone')
})

it('opens one file of a connection after another, each as a preview of its own', async () => {
  const [y, z] = await Promise.all(['docs:folder/y', 'docs:folder/z ?tab=t.1'].map(anchor =>
    previewAt(focus(8, anchor), [], offers())))
  expect([y, z]).toEqual([
    { gatekeeperId: 8, item: 'docs:folder/y', title: 'Finance' }, { gatekeeperId: 8, item: 'docs:folder/z', title: 'Finance' },
  ])
  // Each is keyed apart, so the frame of the first is not the one sent to the second's spot.
  expect(previewKey(y!)).not.toBe(previewKey(z!))
  // Nor is the first, still open, taken for the second.
  expect(await previewAt(focus(8, 'docs:folder/z ?tab=t.1'), [y!], offers())).toEqual(z)
})
