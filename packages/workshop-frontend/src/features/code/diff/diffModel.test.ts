import { describe, expect, it } from 'vitest'
import { buildDiffModel, type ChangeRun } from './diffModel'

function run(model: { changes: ChangeRun[] }, index = 0): ChangeRun {
  expect(model.changes.length).toBeGreaterThan(index)
  return model.changes[index]
}

describe('buildDiffModel', () => {
  it('reports an added file with no change runs', () => {
    const model = buildDiffModel({
      original: '', modified: 'a\nb\nc', hasOriginal: false, hasModified: true,
    })
    expect(model.status).toBe('Added')
    expect(model.additions).toBe(3)
    expect(model.deletions).toBe(0)
    expect(model.changes).toEqual([])
  })

  it('reports a deleted file as one all-lines deletion run', () => {
    const model = buildDiffModel({
      original: 'a\nb', modified: '', hasOriginal: true, hasModified: false,
    })
    expect(model.status).toBe('Deleted')
    expect(model.deletions).toBe(2)
    const change = run(model)
    expect(change.modifiedStart).toBe(1)
    expect(change.modifiedCount).toBe(0)
    expect(change.originalStart).toBe(1)
    expect(change.originalCount).toBe(2)
    expect(change.deletedText).toEqual(['a', 'b'])
  })

  it('reports identical content as unchanged', () => {
    const model = buildDiffModel({
      original: 'a\nb', modified: 'a\nb', hasOriginal: true, hasModified: true,
    })
    expect(model.status).toBe('Unchanged')
    expect(model.changes).toEqual([])
  })

  it('models a single-line edit as a paired replacement with inline slices', () => {
    const model = buildDiffModel({
      original: 'aaa\nbbb old\nccc',
      modified: 'aaa\nbbb new\nccc',
      hasOriginal: true,
      hasModified: true,
    })
    expect(model.status).toBe('Modified')
    expect(model.additions).toBe(1)
    expect(model.deletions).toBe(1)
    expect(model.changes.length).toBe(1)
    const change = run(model)
    expect(change.modifiedStart).toBe(2)
    expect(change.modifiedCount).toBe(1)
    expect(change.originalStart).toBe(2)
    expect(change.originalCount).toBe(1)
    expect(change.deletedText).toEqual(['bbb old'])
    expect(change.pairedModifiedLines.has(2)).toBe(true)
    expect(change.pairedOriginalLines.has(2)).toBe(true)
    // The changed span covers the differing tail of the line ("old" -> "new").
    const modSlices = change.inlineModifiedRanges.get(2)!
    expect(modSlices.length).toBeGreaterThan(0)
    const covered = 'bbb new'.slice(modSlices[0].startCol - 1, modSlices[0].endCol - 1)
    expect(covered).toContain('new')
  })

  it('pairs an intra-line insertion via the positional fallback', () => {
    const model = buildDiffModel({
      original: 'foo\nbar\nbaz',
      modified: 'foo\nbar extra\nbaz',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.modifiedCount).toBe(1)
    expect(change.originalCount).toBe(1)
    expect(change.pairedModifiedLines.has(2)).toBe(true)
    expect(change.pairedOriginalLines.has(2)).toBe(true)
    const slices = change.inlineModifiedRanges.get(2)
    expect(slices).toBeDefined()
    const text = slices!.map(s => 'bar extra'.slice(s.startCol - 1, s.endCol - 1)).join('')
    expect(text).toContain('extra')
  })

  it('models a pure insertion as an addition-only run anchored at its lines', () => {
    const model = buildDiffModel({
      original: 'one\ntwo',
      modified: 'one\nmiddle\ntwo',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.modifiedStart).toBe(2)
    expect(change.modifiedCount).toBe(1)
    expect(change.originalCount).toBe(0)
    expect(model.additions).toBe(1)
    expect(model.deletions).toBe(0)
  })

  it('anchors a pure deletion before the following modified line', () => {
    const model = buildDiffModel({
      original: 'one\ngone\ntwo',
      modified: 'one\ntwo',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.modifiedCount).toBe(0)
    expect(change.modifiedStart).toBe(2) // the zone renders before "two"
    expect(change.originalStart).toBe(2)
    expect(change.originalCount).toBe(1)
    expect(change.deletedText).toEqual(['gone'])
  })

  it('anchors a deletion at end of file past the last modified line', () => {
    const model = buildDiffModel({
      original: 'keep\ngone1\ngone2',
      modified: 'keep',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.modifiedCount).toBe(0)
    expect(change.modifiedStart).toBe(2) // one past the single remaining line
    expect(change.originalStart).toBe(2)
    expect(change.originalCount).toBe(2)
    expect(change.deletedText).toEqual(['gone1', 'gone2'])
  })

  it('splits an unrelated replacement into separate deletion and addition runs', () => {
    const model = buildDiffModel({
      original: 'aaaa bbbb cccc\ndddd eeee ffff',
      modified: 'wwww xxxx yyyy\nzzzz qqqq rrrr',
      hasOriginal: true,
      hasModified: true,
    })
    expect(model.changes.length).toBe(2)
    const deletion = run(model, 0)
    const addition = run(model, 1)
    expect(deletion.modifiedCount).toBe(0)
    expect(deletion.originalCount).toBe(2)
    expect(addition.originalCount).toBe(0)
    expect(addition.modifiedCount).toBe(2)
    // Both anchored at the same modified line: red above green.
    expect(deletion.modifiedStart).toBe(addition.modifiedStart)
    // The addition sits directly past the deleted lines, so the split layout's original-side
    // blank zone (after originalStart - 1) lands right after the red block.
    expect(addition.originalStart).toBe(deletion.originalStart + deletion.originalCount)
    expect(deletion.pairedOriginalLines.size).toBe(0)
    expect(addition.pairedModifiedLines.size).toBe(0)
  })

  it('keeps a mostly-preserved multi-line edit as one paired replacement', () => {
    const original = 'function add(a, b) {\n  return a + b\n}'
    const modified = 'function add(a, b, c) {\n  return a + b + c\n}'
    const model = buildDiffModel({ original, modified, hasOriginal: true, hasModified: true })
    // Preservation is high on both sides, so no deletion/addition split.
    for (const change of model.changes) {
      expect(change.modifiedCount).toBeGreaterThan(0)
      expect(change.originalCount).toBeGreaterThan(0)
    }
  })

  it('counts multi-run diffs across separated chunks', () => {
    const model = buildDiffModel({
      original: 'head old\nsame1\nsame2\nsame3\ntail old',
      modified: 'head new\nsame1\nsame2\nsame3\ntail new',
      hasOriginal: true,
      hasModified: true,
    })
    expect(model.changes.length).toBe(2)
    expect(model.additions).toBe(2)
    expect(model.deletions).toBe(2)
    expect(run(model, 0).modifiedStart).toBe(1)
    expect(run(model, 1).modifiedStart).toBe(5)
  })

  it('expands a sub-word edit to whole-word inline highlights', () => {
    const model = buildDiffModel({
      original: 'the cat sat',
      modified: 'the bat sat',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.pairedModifiedLines.has(1)).toBe(true)
    const modText = change.inlineModifiedRanges.get(1)!
      .map(s => 'the bat sat'.slice(s.startCol - 1, s.endCol - 1)).join('')
    expect(modText).toBe('bat')
    const origText = change.inlineOriginalRanges.get(1)!
      .map(s => 'the cat sat'.slice(s.startCol - 1, s.endCol - 1)).join('')
    expect(origText).toBe('cat')
  })

  it('highlights only the replaced word of a mostly-unchanged sentence', () => {
    const original = 'these two sentences are mostly the same'
    const modified = 'these two sentences are nearly the same'
    const model = buildDiffModel({ original, modified, hasOriginal: true, hasModified: true })
    expect(model.changes.length).toBe(1)
    const change = run(model)
    const modText = change.inlineModifiedRanges.get(1)!
      .map(s => modified.slice(s.startCol - 1, s.endCol - 1)).join('')
    expect(modText).toBe('nearly')
    const origText = change.inlineOriginalRanges.get(1)!
      .map(s => original.slice(s.startCol - 1, s.endCol - 1)).join('')
    expect(origText).toBe('mostly')
  })

  it('splits unrelated sentences that only share letters into deletion and addition', () => {
    // A char-minimal diff finds plenty of common letters here; at word granularity nothing
    // is preserved, so the lines render as a whole-line deletion plus addition.
    const model = buildDiffModel({
      original: 'The quick brown fox jumps over the dog',
      modified: 'Some entirely unrelated sentence goes here',
      hasOriginal: true,
      hasModified: true,
    })
    expect(model.changes.length).toBe(2)
    const deletion = run(model, 0)
    const addition = run(model, 1)
    expect(deletion.modifiedCount).toBe(0)
    expect(deletion.originalCount).toBe(1)
    expect(addition.originalCount).toBe(0)
    expect(addition.modifiedCount).toBe(1)
    expect(deletion.inlineOriginalRanges.size).toBe(0)
    expect(addition.inlineModifiedRanges.size).toBe(0)
  })

  it('splits a line rewritten into different words despite shared characters', () => {
    // "a1" -> "a2" shares its first character, but the whole word changed: no pairing.
    const model = buildDiffModel({
      original: 'a1', modified: 'a2', hasOriginal: true, hasModified: true,
    })
    expect(model.changes.length).toBe(2)
    expect(run(model, 0).originalCount).toBe(1)
    expect(run(model, 0).modifiedCount).toBe(0)
    expect(run(model, 1).modifiedCount).toBe(1)
    expect(run(model, 1).originalCount).toBe(0)
  })

  it('keeps an unchanged line between two nearby edits out of both runs', () => {
    const model = buildDiffModel({
      original: 'aaa\nbbb old\nccc',
      modified: 'aaa\nbbb new\nccc\nadded',
      hasOriginal: true,
      hasModified: true,
    })
    // Line 3 ("ccc") is unchanged: the replacement on line 2 and the addition of line 4 stay
    // separate runs that never cover it.
    expect(model.changes.length).toBe(2)
    const replacement = run(model, 0)
    expect(replacement.modifiedStart).toBe(2)
    expect(replacement.modifiedCount).toBe(1)
    const addition = run(model, 1)
    expect(addition.modifiedStart).toBe(4)
    expect(addition.modifiedCount).toBe(1)
    expect(addition.originalCount).toBe(0)
    expect(model.additions).toBe(2)
    expect(model.deletions).toBe(1)
  })

  it('falls back to a prefix/suffix range when line tokens run out', () => {
    // More distinct lines than the one-char token space: the model degrades to a single
    // trimmed range instead of a precise line diff.
    const many = Array.from({ length: 64000 }, (_, i) => `line ${i}`)
    const original = ['same', ...many, 'tail'].join('\n')
    const modified = ['same', 'other', 'tail'].join('\n')
    const model = buildDiffModel({ original, modified, hasOriginal: true, hasModified: true })
    expect(model.status).toBe('Modified')
    expect(model.deletions).toBe(64000)
    expect(model.additions).toBe(1)
  })

  it('preserves carriage returns inside lines (only \\n separates)', () => {
    const model = buildDiffModel({
      original: 'a\r\nb',
      modified: 'a\r\nb!',
      hasOriginal: true,
      hasModified: true,
    })
    const change = run(model)
    expect(change.modifiedStart).toBe(2)
    expect(change.deletedText).toEqual(['b'])
  })
})
