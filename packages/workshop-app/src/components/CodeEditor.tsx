import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension, type Range, type Text } from '@codemirror/state'
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap,
  lineNumbers, type DecorationSet,
} from '@codemirror/view'
import { bracketMatching, codeFolding, foldGutter, foldKeymap, indentOnInput, indentUnit } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from '@codemirror/commands'
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from '@codemirror/search'
import { Chunk, getChunks, getOriginalDoc, MergeView, unifiedMergeView } from '@codemirror/merge'
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

/**
 * One edit typed in it, as CodeMirror's ChangeSet has it in JSON: sections over the whole text
 * before it, a number keeping that many UTF-16 units and `[deleted, ...lines]` replacing them.
 */
export type CodeTextChange = (number | [number, ...string[]])[]

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
  /**
   * It can be typed in: with undo and redo, brackets closed as they are opened, lines indented as
   * they are begun, Tab to indent (Escape then Tab leaves it, as CodeMirror's tab focus mode has
   * it), and Cmd or Ctrl with / to comment lines out. A diff is typed in on its side after.
   */
  editable?: boolean
  /**
   * Its text as it is typed, with the edit that made it: not as it is given from outside (`text`).
   * Says whether the edit was taken: one that was not is undone, back to `text`.
   */
  onChange?: (text: string, change: CodeTextChange) => boolean
  /** Cmd or Ctrl with S. */
  onSave?: () => void
  /**
   * Where it is typed in, its undo history is kept under this when it is put away, and taken up
   * again when it is shown with the text it was left with.
   */
  historyKey?: string
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

// What was typed in each, with its undo history, by `historyKey`, for the last few.
const histories = new Map<string, { doc: string }>()
const KEPT_HISTORIES = 32

// The diff in one column, over `original`, or none: what is unchanged folded away where it is
// `collapsed`.
const inlineDiff = (original: string | undefined, collapsed: boolean): Extension => original === undefined ? [] : unifiedMergeView({
  original,
  highlightChanges: true,
  gutter: true,
  mergeControls: false,
  syntaxHighlightDeletions: true,
  ...(collapsed ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
})

// A change of the text from outside (`text`), which is not told back (`onChange`).
const fromOutside = Annotation.define<boolean>()

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

// The one span that turns `from` into `to`: what is between what they start and end with alike,
// never splitting a UTF-16 surrogate pair.
const changedSpan = (from: string, to: string) => {
  const most = Math.min(from.length, to.length)
  let start = 0
  while (start < most && from.charCodeAt(start) === to.charCodeAt(start)) start++
  if (start > 0 && /[\uD800-\uDBFF]/.test(from[start - 1]!)) start--
  let end = 0
  while (end < most - start && from.charCodeAt(from.length - 1 - end) === to.charCodeAt(to.length - 1 - end)) end++
  if (end > 0 && /[\uDC00-\uDFFF]/.test(from[from.length - end]!)) end--
  return { from: start, to: from.length - end, insert: to.slice(start, to.length - end) }
}

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

// What typing in it takes, or its being only read. On a touch screen code that is only read
// takes no caret, which would bring up the keyboard.
const editing = (editable: boolean, label: string, save: () => boolean): Extension => [
  EditorState.readOnly.of(!editable),
  EditorView.editable.of(editable || !touch()),
  EditorView.contentAttributes.of(editable ? { 'aria-label': label } : { 'aria-label': label, 'aria-readonly': 'true' }),
  editable ? [closeBrackets(), indentOnInput(), keymap.of([{ key: 'Mod-s', run: save, preventDefault: true }, ...closeBracketsKeymap, ...historyKeymap, indentWithTab])] : [],
]

/**
 * Code, as the editors engineers know show it, drawn in the app's own look (`codeEditorTheme`):
 * line numbers that pick lines out, blocks that fold, guides down each step of indentation, matching
 * brackets, the other places a selected word comes up, find (Cmd or Ctrl with F) and go to line
 * (Ctrl with G) in the app's own bars, and the caret and selection keys. It is read, or typed in
 * where it is `editable`, and text given from outside replaces what is in it where it differs,
 * so that the caret, the scroll and the undo history stay. Coloured once its language has loaded,
 * which happens the first time one is shown. Given what it was before (`diff`), it is shown as
 * the change from that. Lines end only at a line feed, so that its places are the text's.
 */
export const CodeEditor = ({
  text, language, label, diff, wrap = false, picked: pickedLines, onPick, onStatus, memoryKey, editable = false, onChange, onSave, historyKey, className, ref,
}: CodeEditorProps) => {
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
  const callbacks = useRef({ onPick, onStatus, onChange, onSave })
  callbacks.current = { onPick, onStatus, onChange, onSave }
  const wrapping = useRef(new Compartment())
  const languages = useRef(new Compartment())
  const typing = useRef(new Compartment())
  const undo = useRef(new Compartment())
  const textNow = useRef(text)
  textNow.current = text
  // The text last told of as typed, and the text last taken in, which coming back as `text`
  // change nothing.
  const typed = useRef<string>(undefined)
  const taken = useRef<string>(undefined)
  const editableNow = useRef(editable)
  editableNow.current = editable
  const historyKeyNow = useRef(historyKey)
  historyKeyNow.current = historyKey
  const wrapNow = useRef(wrap)
  wrapNow.current = wrap
  const pickedNow = useRef(pickedLines)
  pickedNow.current = pickedLines
  const original = diff?.original
  const layout = diff?.layout
  // Two columns are an editor of their own, made again as the diff comes and goes; one column is
  // this one, which takes the diff on and off in place, so that typing in a file that changes it
  // into a diff keeps the caret, the focus and the undo history.
  const splitOriginal = layout === 'split' ? original : undefined
  const inline = layout === 'split' ? undefined : original
  const inlineNow = useRef(inline)
  inlineNow.current = inline
  const merging = useRef(new Compartment())
  const inlineShown = useRef<string>(undefined)
  // Bumped once the language a diff waits for has loaded.
  const [languageLoads, setLanguageLoads] = useState(0)

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    // A language that has loaded colours the text from the start, so a file shown again never
    // flashes plain. A diff waits for it: what was taken away is coloured once, as it is drawn.
    const support = language && loadedCodeLanguage(language)
    if (language && !support && (splitOriginal ?? inlineNow.current) !== undefined) {
      let waiting = true
      void loadCodeLanguage(language).then(() => waiting && setLanguageLoads((count) => count + 1), () => waiting && setLanguageLoads((count) => count + 1))
      return () => { waiting = false }
    }
    const doc = textNow.current
    taken.current = doc
    const { unit, label: indentLabel } = detectIndent(doc)
    let anchor: number | undefined
    let counted: CodeEditorStatus['diff']
    // How a diff's lines changed, counted again as its text changes.
    let count: ((state: EditorState) => CodeEditorStatus['diff']) | undefined
    const report = EditorView.updateListener.of((update) => {
      const reconfigured = update.transactions.some((transaction) => transaction.reconfigured)
      if ((update.docChanged || reconfigured) && count) counted = count(update.state)
      if (update.selectionSet || update.docChanged || reconfigured) callbacks.current.onStatus?.(statusOf(update.state, indentLabel, counted))
      if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(fromOutside))) {
        const now = update.state.doc.toString()
        typed.current = now
        // Not taken, as where the agent began meanwhile: put back as given, once this update is done.
        if (callbacks.current.onChange?.(now, update.changes.toJSON() as CodeTextChange) === false) {
          typed.current = undefined
          queueMicrotask(() => {
            const editor = view.current
            if (editor !== update.view) return
            const given = textNow.current
            const was = editor.state.doc.toString()
            taken.current = given
            if (was !== given) editor.dispatch({ changes: changedSpan(was, given), annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)] })
          })
        }
      }
    })
    const save = () => {
      callbacks.current.onSave?.()
      return true
    }
    const base = (side: 'a' | 'b'): Extension => [
      side === 'a' ? editing(false, `${label}, before`, save) : typing.current.of(editing(editableNow.current, label, save)),
      side === 'a' ? [] : undo.current.of(editableNow.current ? history() : []),
      EditorState.lineSeparator.of('\n'),
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
    if (splitOriginal !== undefined) {
      const merge = new MergeView({
        a: { doc: splitOriginal, extensions: [base('a')] },
        b: { doc, extensions: [base('b'), codeFind, codeGoToLine, keys, report] },
        parent,
        highlightChanges: true,
        gutter: true,
        collapseUnchanged: { margin: 3, minSize: 6 },
      })
      editors = [merge.a, merge.b]
      view.current = merge.b
      scroller = merge.dom
      count = (state) => countChanges(Chunk.build(merge.a.state.doc, state.doc), merge.a.state.doc, state.doc)
      counted = count(merge.b.state)
      destroy = () => merge.destroy()
    } else {
      inlineShown.current = inlineNow.current
      const extensions = [base('b'), codeFind, codeGoToLine, keys, report, merging.current.of(inlineDiff(inlineNow.current, true))]
      // Taken up again where it was left, typed in, with its undo history, as its change too.
      const kept = historyKeyNow.current && editableNow.current ? histories.get(historyKeyNow.current) : undefined
      const state = kept?.doc === doc
        ? EditorState.fromJSON(kept, { extensions }, { history: historyField })
        : EditorState.create({ doc, extensions })
      const editor = new EditorView({ parent, state })
      editors = [editor]
      view.current = editor
      scroller = editor.scrollDOM
      count = (now) => {
        const chunks = getChunks(now)
        return chunks ? countChanges(chunks.chunks, getOriginalDoc(now), now.doc) : undefined
      }
      counted = count(editor.state)
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
      const keptUnder = historyKeyNow.current
      if (keptUnder && main.state.field(historyField, false)) {
        histories.delete(keptUnder)
        histories.set(keptUnder, main.state.toJSON({ history: historyField }) as { doc: string })
        if (histories.size > KEPT_HISTORIES) histories.delete(histories.keys().next().value!)
      }
      if (memoryKey) {
        scrolled.delete(memoryKey)
        scrolled.set(memoryKey, scroller.scrollTop)
        if (scrolled.size > KEPT_PLACES) scrolled.delete(scrolled.keys().next().value!)
      }
      destroy()
      view.current = null
      editorsNow.current = []
    }
    // The picked lines, wrapping, text and typing are applied as they change, below, not by
    // starting over.
  }, [splitOriginal, language, label, memoryKey, languageLoads])

  // The diff in one column, put on, changed or taken off in place, with nothing folded away: it is
  // come to from the file as it was being read or typed in, whose place would move.
  useEffect(() => {
    const editor = view.current
    if (!editor || editorsNow.current.length !== 1 || inlineShown.current === inline) return
    inlineShown.current = inline
    editor.dispatch({ effects: merging.current.reconfigure(inlineDiff(inline, false)) })
  }, [inline])

  // Text given from outside, as someone else's edit or a file put back as it was: only the span
  // that differs, so that the caret and the scroll stay where they are, and out of the undo
  // history, which steps over it. Each render, before anything is drawn, as an edit typed here
  // that was not taken leaves the text it was given the same.
  useLayoutEffect(() => {
    const editor = view.current
    if (!editor || text === taken.current || text === typed.current) return
    const doc = editor.state.doc.toString()
    taken.current = text
    if (doc === text) return
    editor.dispatch({ changes: changedSpan(doc, text), annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)] })
    typed.current = undefined
  })

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const save = () => {
      callbacks.current.onSave?.()
      return true
    }
    const effects = [typing.current.reconfigure(editing(editable, label, save))]
    if (editable !== (editor.state.field(historyField, false) !== undefined)) effects.push(undo.current.reconfigure(editable ? history() : []))
    editor.dispatch({ effects })
  }, [editable, original, label])

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
