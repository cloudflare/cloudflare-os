// @vitest-environment jsdom

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'
import { documentFixture, presentationFixture, spreadsheetFixture } from './fixtures'
import { changeElements, previewTestRoot, renderPreview } from './previewTestRoot'

const testRoot = previewTestRoot()
const scrolled = vi.fn<(options: ScrollToOptions) => void>()
let reducedMotion = false

beforeEach(() => {
  scrolled.mockClear()
  reducedMotion = false
  // Only the preview's own scrolling area moves, never what surrounds it.
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    if (!this.hasAttribute('data-preview-scroll')) throw new Error('Scrolled outside the preview')
    scrolled(options as ScrollToOptions)
  } as typeof Element.prototype.scrollTo
  window.matchMedia = ((query: string) => ({ matches: reducedMotion && query.includes('reduce') })) as unknown as typeof window.matchMedia
})
afterEach(() => testRoot.cleanup())

describe('focus', () => {
  it('opens at the top, and scrolls only when the focus moves to another change', async () => {
    await testRoot.render(renderPreview(documentFixture, { focusedChangeId: 101 }))
    expect(scrolled).not.toHaveBeenCalled()

    await testRoot.render(renderPreview(documentFixture, { focusedChangeId: 103 }))
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }))

    await testRoot.render(renderPreview(documentFixture, { focusedChangeId: 103, decided: [[102, 'approved']] }))
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('jumps without animation under reduced motion', async () => {
    reducedMotion = true
    await testRoot.render(renderPreview(documentFixture, { focusedChangeId: 101 }))
    await testRoot.render(renderPreview(documentFixture, { focusedChangeId: 102 }))
    expect(scrolled).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }))
  })

  it('switches to the sheet holding the focused change', async () => {
    const page = await testRoot.render(renderPreview(spreadsheetFixture, { focusedChangeId: 201 }))
    await testRoot.render(renderPreview(spreadsheetFixture, { focusedChangeId: 205 }))
    const selected = page.querySelector('[aria-label="Sheets"] [aria-selected="true"]')
    expect(selected?.textContent).toContain('Q3 Forecast')
    expect(changeElements(page, 205).length).toBeGreaterThan(0)
    expect(scrolled).toHaveBeenCalledTimes(1)
  })

  it('switches to the slide holding the focused change and outlines its element', async () => {
    const page = await testRoot.render(renderPreview(presentationFixture, { focusedChangeId: 302 }))
    expect(page.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Slide 4 of 6, new')
    const element = changeElements(page, 302).find(e => e.getAttribute('aria-label') === 'Change: Launch-day checklist') as HTMLElement
    expect(element.style.outline).toContain('2px solid')
  })
})

describe('decisions', () => {
  it('draws an approved edit settled and a rejected one undone', async () => {
    const page = await testRoot.render(renderPreview(documentFixture, { decided: [[101, 'approved'], [102, 'rejected']] }))
    const approved = changeElements(page, 101)
    expect(approved.map(e => e.tagName)).toEqual(['INS'])
    expect((approved[0] as HTMLElement).style.textDecorationLine).toBe('none')

    const rejected = changeElements(page, 102) as HTMLElement[]
    expect(rejected.find(e => e.tagName === 'DEL')?.style.textDecorationLine).toBe('none')
    expect(rejected.find(e => e.tagName === 'INS')?.style.textDecorationLine).toBe('line-through')
  })

  it('fades a rejected slide element', async () => {
    const page = await testRoot.render(renderPreview(presentationFixture, { focusedChangeId: 301, decided: [[301, 'rejected']] }))
    const [title] = changeElements(page, 301) as HTMLElement[]
    expect(title.getAttribute('data-change-state')).toBe('rejected')
    expect(Number(title.style.opacity)).toBeLessThan(1)
  })
})

describe('clicking', () => {
  it('reports the change’s log id from every kind of preview', async () => {
    const clicked: number[] = []
    const onChangeClick = (id: number) => clicked.push(id)
    for (const [preview, id] of [[documentFixture, 103], [spreadsheetFixture, 202], [presentationFixture, 301]] as const) {
      const page = await testRoot.render(renderPreview(preview, { onChangeClick, focusedChangeId: id }))
      await act(async () => (changeElements(page, id)[0] as HTMLElement).click())
      testRoot.cleanup()
    }
    expect(clicked).toEqual([103, 202, 301])
  })

  it('activates an inline change from the keyboard', async () => {
    const clicked: number[] = []
    const page = await testRoot.render(renderPreview(documentFixture, { onChangeClick: id => clicked.push(id) }))
    const button = changeElements(page, 101).find(e => e.getAttribute('role') === 'button') as HTMLElement
    expect(button.getAttribute('aria-label')).toBe('Change: Public launch on November 18')
    expect(button.tabIndex).toBe(0)
    await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(clicked).toEqual([101])
  })

  it('never targets an action decided while the preview was drawn', async () => {
    const clicked: number[] = []
    const preview: ResourcePreview = { ...spreadsheetFixture, actions: [-1, ...spreadsheetFixture.actions.slice(1)] }
    const page = await testRoot.render(renderPreview(preview, { onChangeClick: id => clicked.push(id), focusedChangeId: -1 }))
    expect(changeElements(page, -1)).toHaveLength(0)
    const unattributed = page.querySelector('[data-change-state="unattributed"]') as HTMLElement
    expect(unattributed.textContent).toBe('$194,500')
    await act(async () => unattributed.click())
    expect(clicked).toEqual([])
    expect(scrolled).not.toHaveBeenCalled()
  })
})
