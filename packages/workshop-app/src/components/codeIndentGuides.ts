import { RangeSetBuilder, type Line, type Text } from '@codemirror/state'
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view'
import { getIndentUnit } from '@codemirror/language'

// How far a line is indented, in columns, a tab taken to the next stop; none for a blank line.
const indentOf = (line: Line, tabSize: number): number | undefined => {
  let column = 0
  for (const character of line.text) {
    if (character === ' ') column += 1
    else if (character === '\t') column += tabSize - (column % tabSize)
    else return column
  }
  return undefined
}

// A blank line is as deep as the shallower of the lines either side of it, as it is inside both.
const blankIndent = (doc: Text, from: number, tabSize: number) => {
  const near = (step: 1 | -1) => {
    for (let number = from + step, looked = 0; number >= 1 && number <= doc.lines && looked < 200; number += step, looked += 1) {
      const indent = indentOf(doc.line(number), tabSize)
      if (indent !== undefined) return indent
    }
    return 0
  }
  return Math.min(near(-1), near(1))
}

const guidesFor = (view: EditorView): DecorationSet => {
  const { doc, tabSize } = view.state
  const unit = getIndentUnit(view.state) || 2
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = doc.lineAt(position)
      const indent = indentOf(line, tabSize) ?? blankIndent(doc, line.number, tabSize)
      const levels = Math.floor(indent / unit)
      if (levels > 0) {
        builder.add(line.from, line.from, Decoration.line({
          class: 'cm-indent-guides',
          attributes: { style: `--indent-unit: ${unit}ch; --indent-width: ${levels * unit}ch` },
        }))
      }
      position = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * A faint guide down from each step of a line's indentation (`.cm-indent-guides` in the theme), as
 * the editors engineers know draw them, so that how deep a block goes shows without counting. Only
 * the lines on screen are worked out, again as they change.
 */
export const codeIndentGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) {
    this.decorations = guidesFor(view)
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) this.decorations = guidesFor(update.view)
  }
}, { decorations: (plugin) => plugin.decorations })
