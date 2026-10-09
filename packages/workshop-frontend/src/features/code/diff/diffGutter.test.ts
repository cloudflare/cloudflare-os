// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView, lineNumbers } from '@codemirror/view'
import { buildDiffModel } from './diffModel'
import { diffRenderExtension, setDiffRender } from './diffRenderer'

// Mounts a real EditorView to cover the parts diffRenderer.test.ts can't reach state-side:
// that the change-bar gutter and the line-number gutter actually render the diff layer's line
// markers and deletion-zone columns.

function mountView(side: 'modified' | 'original', doc: string): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.lineSeparator.of('\n'),
        diffRenderExtension(side),
        lineNumbers(),
      ],
    }),
  })
}

function renderModel(view: EditorView, original: string) {
  view.dispatch({
    effects: setDiffRender.of({
      model: buildDiffModel({
        original,
        modified: view.state.doc.toString(),
        hasOriginal: true,
        hasModified: true,
      }),
      layout: 'stacked',
      expandedDeletions: new Set(),
      onExpandDeletion: () => {},
    }),
  })
}

describe('diff gutters in a mounted view', () => {
  it('renders per-line change markers into both gutters', () => {
    const view = mountView('modified', 'aaa\nbbb new\nccc\nadded')
    renderModel(view, 'aaa\nbbb old\nccc')
    const dom = view.dom
    const bar = dom.querySelector('.cm-gutter.gadgets-diff-gutter-bar')!
    expect(bar).not.toBeNull()
    // Line 2 is a paired replacement (yellow), line 4 a pure addition (green).
    expect(bar.querySelector('.gadgets-diff-gutter-modified')).not.toBeNull()
    expect(bar.querySelector('.gadgets-diff-gutter-add')).not.toBeNull()
    const numbers = dom.querySelector('.cm-gutter.cm-lineNumbers')!
    expect(numbers.querySelector('.gadgets-diff-gutter-modified')?.textContent).toBe('2')
    expect(numbers.querySelector('.gadgets-diff-gutter-add')?.textContent).toBe('4')
    view.destroy()
  })

  it('renders a deletion zone widget with row-aligned gutter columns', () => {
    const view = mountView('modified', 'aaa\nccc')
    renderModel(view, 'aaa\ngone\nccc')
    const dom = view.dom
    expect(dom.querySelector('.gadgets-deleted-code-zone')?.textContent).toBe('gone')
    // The zone's own gutter columns: a bar row and the deleted line's original number.
    expect(dom.querySelector('.gadgets-deleted-bar-zone .gadgets-deleted-num-row'))
      .not.toBeNull()
    expect(dom.querySelector('.gadgets-deleted-margin')?.textContent).toBe('2')
    view.destroy()
  })
})
