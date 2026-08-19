// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Decoration, DecorationSet, WidgetType } from '@codemirror/view'
import { buildDiffModel } from './diffModel'
import { diffRenderExtension, setDiffRender, type DiffRenderInput } from './diffRenderer'

// Exercises the diff layer's state field directly: EditorState.update applies the
// setDiffRender effect and doc changes without needing a mounted view, and jsdom covers the
// widgets' DOM rendering.

function makeState(side: 'modified' | 'original', doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [EditorState.lineSeparator.of('\n'), diffRenderExtension(side)],
  })
}

function render(
  state: EditorState,
  input: Partial<DiffRenderInput> & { model: DiffRenderInput['model'] },
): EditorState {
  return state.update({
    effects: setDiffRender.of({
      layout: 'stacked',
      expandedDeletions: new Set<string>(),
      onExpandDeletion: () => {},
      ...input,
    }),
  }).state
}

type DecoInfo = { from: number; to: number; deco: Decoration }

function collectDecorations(state: EditorState): DecoInfo[] {
  const sets = state.facet(EditorView.decorations)
    .map(value => (typeof value === 'function' ? value : () => value))
  const found: DecoInfo[] = []
  // The facet is provided by our field; resolve without a view by calling with a fake one
  // (the provider closure only reads the state's field).
  for (const get of sets) {
    const set = get({ state } as unknown as EditorView) as DecorationSet
    const cursor = set.iter()
    while (cursor.value !== null) {
      found.push({ from: cursor.from, to: cursor.to, deco: cursor.value })
      cursor.next()
    }
  }
  return found
}

function lineClasses(state: EditorState): Map<number, string> {
  const classes = new Map<number, string>()
  for (const { from, deco } of collectDecorations(state)) {
    const spec = deco.spec as { class?: string }
    if (deco.spec.widget === undefined && spec.class?.startsWith('gadgets-diff-line-')) {
      classes.set(state.doc.lineAt(from).number, spec.class)
    }
  }
  return classes
}

function widgets(state: EditorState): { from: number; widget: WidgetType }[] {
  return collectDecorations(state)
    .filter(({ deco }) => deco.spec.widget !== undefined)
    .map(({ from, deco }) => ({ from, widget: deco.spec.widget as WidgetType }))
}

const model = (original: string, modified: string) =>
  buildDiffModel({ original, modified, hasOriginal: true, hasModified: true })

describe('diffRenderExtension (modified side)', () => {
  it('decorates added lines and anchors the deletion zone before the replacement', () => {
    const modified = 'aaa\nBBB\nccc'
    const state = render(makeState('modified', modified), {
      model: model('aaa\nbbb\nccc', modified),
    })
    expect(lineClasses(state)).toEqual(new Map([[2, 'gadgets-diff-line-add']]))
    const zones = widgets(state)
    expect(zones.length).toBe(1)
    expect(state.doc.lineAt(zones[0].from).number).toBe(2)
    const dom = zones[0].widget.toDOM(null as unknown as EditorView) as HTMLElement
    expect(dom.className).toBe('gadgets-deleted-code-zone')
    expect(dom.textContent).toContain('bbb')
  })

  it('adds inline marks for the changed span of a paired line', () => {
    const modified = 'aaa\nbbb new\nccc'
    const state = render(makeState('modified', modified), {
      model: model('aaa\nbbb old\nccc', modified),
    })
    const marks = collectDecorations(state).filter(({ deco }) =>
      (deco.spec as { class?: string }).class === 'gadgets-diff-inline-add')
    expect(marks.length).toBeGreaterThan(0)
    const text = marks
      .map(({ from, to }) => state.doc.sliceString(from, to))
      .join('')
    expect(text).toContain('new')
  })

  it('anchors an end-of-file deletion after the last line', () => {
    const modified = 'keep'
    const state = render(makeState('modified', modified), {
      model: model('keep\ngone', modified),
    })
    const zones = widgets(state)
    expect(zones.length).toBe(1)
    expect(zones[0].from).toBe(state.doc.length)
  })

  it('renders hatched blank zones instead of deletion zones in the split layout', () => {
    const modified = 'keep'
    const state = render(makeState('modified', modified), {
      model: model('keep\ngone1\ngone2', modified),
      layout: 'split',
    })
    const zones = widgets(state)
    expect(zones.length).toBe(1)
    const dom = zones[0].widget.toDOM(null as unknown as EditorView) as HTMLElement
    expect(dom.className).toBe('gadgets-diff-blank-zone')
    expect(dom.style.height).toBe('40px') // two missing lines at 20px each
  })

  it('maps decorations through later doc changes and survives a stale model', () => {
    let state = render(makeState('modified', 'aaa\nNEW\nccc'), {
      model: model('aaa\nccc', 'aaa\nNEW\nccc'),
    })
    // Insert a line above the change; the add-line decoration follows its text.
    state = state.update({ changes: { from: 0, insert: 'top\n' } }).state
    expect(lineClasses(state)).toEqual(new Map([[3, 'gadgets-diff-line-add']]))
    // A model referencing lines past the (shrunk) document clamps instead of throwing.
    const shrunk = render(makeState('modified', 'x'), {
      model: model('aaa\nbbb\nccc\nddd', 'aaa\nbbb\nccc\nDDD'),
    })
    expect(lineClasses(shrunk).size).toBe(0)
  })

  it('truncates long deletion zones behind an expand button', () => {
    const deletedLines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`)
    const original = `top\n${deletedLines.join('\n')}\nbottom`
    const modified = 'top\nbottom'
    const diffModel = model(original, modified)
    let expanded: string | null = null
    const collapsed = render(makeState('modified', modified), {
      model: diffModel,
      onExpandDeletion: key => { expanded = key },
    })
    const dom = widgets(collapsed)[0].widget.toDOM(null as unknown as EditorView) as HTMLElement
    const button = dom.querySelector('button')!
    expect(button.textContent).toBe('Show 34 hidden deleted lines') // 130 - 2*48
    expect(dom.children.length).toBe(97) // 48 + button + 48
    button.dispatchEvent(new MouseEvent('click'))
    expect(expanded).toBe(diffModel.changes[0].key)

    const expandedState = render(makeState('modified', modified), {
      model: diffModel,
      expandedDeletions: new Set([diffModel.changes[0].key]),
    })
    const expandedDom =
      widgets(expandedState)[0].widget.toDOM(null as unknown as EditorView) as HTMLElement
    expect(expandedDom.querySelector('button')).toBeNull()
    expect(expandedDom.children.length).toBe(130)
  })

  it('reuses equal widgets across model rebuilds (eq by content)', () => {
    const original = 'aaa\ngone\nccc'
    const modified = 'aaa\nccc'
    const first = widgets(render(makeState('modified', modified), {
      model: model(original, modified),
    }))[0].widget
    const second = widgets(render(makeState('modified', modified), {
      model: model(original, modified),
    }))[0].widget
    expect(first).not.toBe(second)
    expect(first.eq(second)).toBe(true)
  })
})

describe('diffRenderExtension (original side)', () => {
  it('decorates deleted lines and aligns additions with blank zones', () => {
    const original = 'aaa\nbbb\nccc'
    const state = render(makeState('original', original), {
      model: model(original, 'aaa\nbbb\nnew1\nnew2\nccc'),
      layout: 'split',
    })
    expect(lineClasses(state).size).toBe(0) // pure addition deletes nothing
    const zones = widgets(state)
    expect(zones.length).toBe(1)
    expect(state.doc.lineAt(zones[0].from).number).toBe(2)
    const dom = zones[0].widget.toDOM(null as unknown as EditorView) as HTMLElement
    expect(dom.className).toBe('gadgets-diff-blank-zone')
    expect(dom.style.height).toBe('40px')
  })

  it('keeps an unrelated replacement aligned: blank zone directly after the red block', () => {
    // Unrelated content splits into deletion + addition runs (see diffModel); the sides must
    // still align row for row: [red|blank][blank|green], unchanged lines level again after.
    const original = 'aaaa bbbb cccc\ndddd eeee ffff\ntail'
    const modified = 'wwww xxxx yyyy\ntail'
    const diffModel = model(original, modified)
    expect(diffModel.changes.length).toBe(2)

    const originalState = render(makeState('original', original), {
      model: diffModel, layout: 'split',
    })
    const originalZones = widgets(originalState)
    expect(originalZones.length).toBe(1)
    // Directly after the last red line (line 2), not after the unchanged "tail".
    expect(originalZones[0].from).toBe(originalState.doc.line(2).to)

    const modifiedState = render(makeState('modified', modified), {
      model: diffModel, layout: 'split',
    })
    const modifiedZones = widgets(modifiedState)
    expect(modifiedZones.length).toBe(1)
    // Before the green line, mirroring the stacked red-above-green anchoring.
    expect(modifiedZones[0].from).toBe(0)
  })

  it('marks replaced lines as delete lines with inline delete marks', () => {
    const original = 'aaa\nbbb old\nccc'
    const state = render(makeState('original', original), {
      model: model(original, 'aaa\nbbb new\nccc'),
      layout: 'split',
    })
    expect(lineClasses(state)).toEqual(new Map([[2, 'gadgets-diff-line-delete']]))
    const marks = collectDecorations(state).filter(({ deco }) =>
      (deco.spec as { class?: string }).class === 'gadgets-diff-inline-delete')
    const text = marks
      .map(({ from, to }) => state.doc.sliceString(from, to))
      .join('')
    expect(text).toContain('old')
  })
})
