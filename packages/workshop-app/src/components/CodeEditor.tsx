import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Compartment, EditorSelection, EditorState, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap,
  lineNumbers, type DecorationSet,
} from '@codemirror/view'
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentUnit } from '@codemirror/language'
import { defaultKeymap } from '@codemirror/commands'
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search'
import { getChunks, getOriginalDoc, MergeView, unifiedMergeView, type Chunk } from '@codemirror/merge'
import type { CodeLanguage } from '@/files/codeLanguage'
import { codeEditorTheme } from './codeEditorTheme'
import { codeIndentGuides } from './codeIndentGuides'
import { loadCodeLanguage, loadedCodeLanguage } from './codeLanguages'
import { codeFind, codeGoToLine, openGoToLine } from './codePanels'
import { detectIndent } from './detectIndent'

/** A run of lines, counted from 1, both ends included. */
export type CodeLines = { from: number; to: number }

/** Where the reader is in the code, for a status line to say. */
export type CodeEditorStatus = {
  line: number
  column: number
  /** What is selected, when something is. */
  selected?: { characters: number; lines: number }
  /** How the file is indented: "Spaces: 2", "Tabs". */
  indent: string
  /** How many lines it has. */
  lines: number
  /** Where it is shown as a diff, how many lines the change added and took away. */
  diff?: { added: number; removed: number }
}

/** What can be asked of the editor from outside, as from a menu. */
export type CodeEditorHandle = {
  openFind: () => void
  openGoToLine: () => void
  goToLine: (line: number) => void
  focus: () => void
}

export type CodeEditorProps = {
  text: string
  /** What it is written in; none is shown as plain text. */
  language?: CodeLanguage
  /** What the code is, as the editor's accessible name: "client.js". */
  label: string
  /**
   * What it was before, to show it as a diff against: in one column, what was taken away above what
   * took its place, or in two, side by side. Long runs that did not change are folded away.
   */
  diff?: { original: string; layout: 'unified' | 'split' }
  /** Long lines wrap to the width, rather than running on to be scrolled to. */
  wrap?: boolean
  /** Lines picked out, as a link to them names: marked down the side, and scrolled to on opening. */
  picked?: CodeLines
  /** Lines picked from the gutter (a click, then Shift with a click for a run), or none. */
  onPick?: (lines: CodeLines | undefined) => void
  onStatus?: (status: CodeEditorStatus) => void
  /** Where it was scrolled to is kept under this, for coming back to it. */
  memoryKey?: string
  className?: string
  ref?: Ref<CodeEditorHandle>
}

const setPicked = StateEffect.define<CodeLines | undefined>()
const PICKED_LINE = Decoration.line({ class: 'cm-picked-line' })
const picked = StateField.define<{ lines?: CodeLines; marks: DecorationSet }>({
  create: () => ({ marks: Decoration.none }),
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setPicked)) continue
      const lines = effect.value
      const { doc } = transaction.state
      const marks: Range<Decoration>[] = []
      if (lines) for (let number = Math.max(1, lines.from); number <= Math.min(lines.to, doc.lines); number += 1) marks.push(PICKED_LINE.range(doc.line(number).from))
      return { lines, marks: Decoration.set(marks) }
    }
    return value.marks.size ? { ...value, marks: value.marks.map(transaction.changes) } : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

// Where each was scrolled to, for the last few, so that going back to a file finds the place.
const scrolled = new Map<string, number>()
const KEPT_PLACES = 64

// A caret for each block the gutter can fold, which the theme draws (`.cm-fold-marker`).
const foldMarker = (open: boolean) => {
  const marker = document.createElement('span')
  marker.className = 'cm-fold-marker'
  marker.dataset.open = String(open)
  marker.title = open ? 'Fold' : 'Unfold'
  return marker
}

// On a touch screen the code is only read: a caret there would bring up the keyboard.
const touch = () => window.matchMedia('(pointer: coarse)').matches

// How many lines a chunk of a diff spans in one of its documents.
const linesIn = (doc: Text, from: number, to: number) => (to > from ? doc.lineAt(to - 1).number - doc.lineAt(from).number + 1 : 0)

/** How many lines a diff's chunks add to `after` and take from `before`. */
const countChanges = (chunks: readonly Chunk[], before: Text, after: Text) => chunks.reduce(
  (sum, chunk) => ({ added: sum.added + linesIn(after, chunk.fromB, chunk.toB), removed: sum.removed + linesIn(before, chunk.fromA, chunk.toA) }),
  { added: 0, removed: 0 },
)

const statusOf = (state: EditorState, indent: string, diff?: CodeEditorStatus['diff']): CodeEditorStatus => {
  const { main } = state.selection
  const line = state.doc.lineAt(main.head)
  const status: CodeEditorStatus = { line: line.number, column: main.head - line.from + 1, indent, lines: state.doc.lines, diff }
  if (!main.empty) {
    const lines = state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number + 1
    status.selected = { characters: main.to - main.from, lines }
  }
  return status
}

/**
 * Code, as the editors engineers know show it, drawn in the app's own look (`codeEditorTheme`):
 * line numbers that pick lines out, blocks that fold, guides down each step of indentation, matching
 * brackets, the other places a selected word comes up, find (Cmd or Ctrl with F) and go to line
 * (Ctrl with G) in the app's own bars, and the caret and selection keys. It is only read: its text
 * changes only from outside. Coloured once its language has loaded, which happens the first time
 * one is shown. Given what it was before (`diff`), it is shown as the change from that.
 */
export const CodeEditor = ({ text, language, label, diff, wrap = false, picked: pickedLines, onPick, onStatus, memoryKey, className, ref }: CodeEditorProps) => {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView>(null)
  // Every editor shown: one, or a diff's two sides.
  const editorsNow = useRef<EditorView[]>([])
  useImperativeHandle(ref, () => ({
    openFind: () => { if (view.current) openSearchPanel(view.current) },
    openGoToLine: () => { if (view.current) openGoToLine(view.current) },
    goToLine: (number) => {
      const editor = view.current
      if (!editor) return
      const line = editor.state.doc.line(Math.min(Math.max(number, 1), editor.state.doc.lines))
      editor.dispatch({ selection: EditorSelection.cursor(line.from), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) })
      editor.focus()
    },
    focus: () => view.current?.focus(),
  }), [])
  const callbacks = useRef({ onPick, onStatus })
  callbacks.current = { onPick, onStatus }
  const wrapping = useRef(new Compartment())
  const languages = useRef(new Compartment())
  const wrapNow = useRef(wrap)
  wrapNow.current = wrap
  const pickedNow = useRef(pickedLines)
  pickedNow.current = pickedLines
  const original = diff?.original
  const layout = diff?.layout
  // Bumped once the language a diff waits for has loaded.
  const [languageLoads, setLanguageLoads] = useState(0)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    // A language that has loaded colours the text from the start, so a file shown again never
    // flashes plain. A diff waits for it: what was taken away is coloured once, as it is drawn.
    const support = language && loadedCodeLanguage(language)
    if (language && !support && original !== undefined) {
      let waiting = true
      void loadCodeLanguage(language).then(() => waiting && setLanguageLoads((count) => count + 1), () => waiting && setLanguageLoads((count) => count + 1))
      return () => { waiting = false }
    }
    const { unit, label: indentLabel } = detectIndent(text)
    let anchor: number | undefined
    let counted: CodeEditorStatus['diff']
    const report = EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) callbacks.current.onStatus?.(statusOf(update.state, indentLabel, counted))
    })
    const base = (side: 'a' | 'b'): Extension => [
      EditorState.readOnly.of(true),
      EditorView.editable.of(!touch()),
      EditorView.contentAttributes.of({ 'aria-label': side === 'a' ? `${label}, before` : label, 'aria-readonly': 'true' }),
      EditorState.tabSize.of(unit === '\t' ? 4 : unit.length),
      indentUnit.of(unit),
      lineNumbers({
        domEventHandlers: side === 'a' ? {} : {
          mousedown(editor, block, event) {
            const number = editor.state.doc.lineAt(block.from).number
            const mouse = event as MouseEvent
            const current = editor.state.field(picked).lines
            // A second click on the only line picked puts it back.
            const lines = mouse.shiftKey && anchor !== undefined
              ? { from: Math.min(anchor, number), to: Math.max(anchor, number) }
              : current && current.from === number && current.to === number ? undefined : { from: number, to: number }
            if (!mouse.shiftKey) anchor = lines ? number : undefined
            editor.dispatch({ effects: setPicked.of(lines) })
            callbacks.current.onPick?.(lines)
            return true
          },
        },
      }),
      codeFolding({ placeholderText: '⋯' }),
      foldGutter({ markerDOM: foldMarker }),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      highlightSpecialChars(),
      drawSelection(),
      bracketMatching(),
      highlightSelectionMatches({ minSelectionLength: 2 }),
      codeIndentGuides,
      picked,
      wrapping.current.of(wrapNow.current ? EditorView.lineWrapping : []),
      languages.current.of(support || []),
      codeEditorTheme,
    ]
    const keys = keymap.of([{ key: 'Ctrl-g', run: openGoToLine, preventDefault: true }, ...searchKeymap, ...foldKeymap, ...defaultKeymap])

    let editors: EditorView[]
    let scroller: HTMLElement
    let destroy: () => void
    if (original !== undefined && layout === 'split') {
      const merge = new MergeView({
        a: { doc: original, extensions: [base('a')] },
        b: { doc: text, extensions: [base('b'), codeFind, codeGoToLine, keys, report] },
        parent,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      })
      editors = [merge.a, merge.b]
      view.current = merge.b
      scroller = merge.dom
      counted = countChanges(merge.chunks, merge.a.state.doc, merge.b.state.doc)
      destroy = () => merge.destroy()
    } else {
      const extensions = [base('b'), codeFind, codeGoToLine, keys, report]
      if (original !== undefined) {
        extensions.push(unifiedMergeView({
          original,
          highlightChanges: true,
          gutter: true,
          mergeControls: false,
          syntaxHighlightDeletions: true,
          collapseUnchanged: { margin: 3, minSize: 6 },
        }))
      }
      const editor = new EditorView({ parent, state: EditorState.create({ doc: text, extensions }) })
      editors = [editor]
      view.current = editor
      scroller = editor.scrollDOM
      const chunks = original !== undefined ? getChunks(editor.state) : null
      const before = original !== undefined ? getOriginalDoc(editor.state) : undefined
      if (chunks && before) counted = countChanges(chunks.chunks, before, editor.state.doc)
      destroy = () => editor.destroy()
    }

    editorsNow.current = editors
    const main = view.current
    callbacks.current.onStatus?.(statusOf(main.state, indentLabel, counted))
    const lines = pickedNow.current
    if (lines && lines.from <= main.state.doc.lines) {
      anchor = lines.from
      main.dispatch({ effects: [setPicked.of(lines), EditorView.scrollIntoView(main.state.doc.line(lines.from).from, { y: 'center' })] })
    } else if (memoryKey && scrolled.has(memoryKey)) {
      const top = scrolled.get(memoryKey)!
      requestAnimationFrame(() => { scroller.scrollTop = top })
    }

    let cancelled = false
    if (language && !support) {
      void loadCodeLanguage(language).then((support) => {
        if (!cancelled) for (const editor of editors) editor.dispatch({ effects: languages.current.reconfigure(support) })
      }, () => {})
    }

    return () => {
      cancelled = true
      if (memoryKey) {
        scrolled.delete(memoryKey)
        scrolled.set(memoryKey, scroller.scrollTop)
        if (scrolled.size > KEPT_PLACES) scrolled.delete(scrolled.keys().next().value!)
      }
      destroy()
      view.current = null
      editorsNow.current = []
    }
    // The picked lines and wrapping are applied as they change, below, not by starting over.
  }, [text, original, layout, language, label, memoryKey, languageLoads])

  useEffect(() => {
    for (const editor of editorsNow.current) editor.dispatch({ effects: wrapping.current.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])

  // Picked from outside, as by following a link to lines: marked, and brought into view.
  const from = pickedLines?.from
  const to = pickedLines?.to
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.field(picked).lines
    if (current?.from === from && current?.to === to) return
    const lines = from !== undefined && to !== undefined ? { from, to } : undefined
    const effects: StateEffect<unknown>[] = [setPicked.of(lines)]
    if (lines && lines.from <= editor.state.doc.lines) effects.push(EditorView.scrollIntoView(editor.state.doc.line(lines.from).from, { y: 'nearest' }))
    editor.dispatch({ effects })
  }, [from, to])

  return <div ref={host} className={cn('relative h-full min-h-0 overflow-hidden [&_.cm-mergeView]:h-full [&_.cm-mergeView]:overflow-auto', className)} />
}
