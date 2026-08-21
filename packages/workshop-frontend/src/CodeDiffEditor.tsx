import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Columns, Rows } from '@phosphor-icons/react'
import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection,
} from '@codemirror/view'
import { bracketMatching, indentOnInput, indentUnit } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import {
  connectSessionRemote, sessionChangeListener, setDocText, type EditSession,
} from './CodeEditor'
import { codeEditorTheme, monoFont } from './components/codeTheme'
import { buildDiffModel, type DiffStatus } from './diff/diffModel'
import { diffRenderExtension, setDiffRender } from './diff/diffRenderer'
import { getLanguage } from './getLanguage'
import { useTheme } from './ThemeContext'
import './CodeDiffEditor.css'

/**
 * The in-chat diff editor.
 *
 * 1. A CodeMirror editor shows the chat's version of the file, editable and OT-bound through
 *    the same EditSession contract as CodeEditor (one client per chat owns the content; this
 *    editor is just another view on it).
 * 2. `buildDiffModel` (./diff/diffModel) diffs the committed original against the editor's
 *    document, rAF-coalesced per keystroke.
 * 3. `diffRenderExtension` (./diff/diffRenderer) renders the model as decorations, gutter
 *    markers, and block widgets (red deletion zones above modified lines).
 * 4. The split layout (width-gated, sticky via localStorage) adds a second read-only editor
 *    showing the original, with hatched blank zones keeping the sides aligned and their
 *    scrollTops synced.
 */

interface CodeDiffEditorProps {
  filename: string | null
  /** Committed (original) text; null = the file does not exist at head (an added file). */
  original: string | null
  /** The chat-side text when no session applies. Ignored when session is set. */
  text?: string | null
  /** Editable OT-bound session for the chat side; absent = read-only. */
  session?: EditSession
  readOnly?: boolean
  height?: string | number
}

type DiffLayoutPreference = 'stacked' | 'split'

const DIFF_LAYOUT_STORAGE_KEY = 'gadgets:workshop:diffLayout'
const SPLIT_DIFF_MIN_WIDTH = 1100

function getInitialDiffLayoutPreference(): DiffLayoutPreference {
  try {
    const stored = window.localStorage.getItem(DIFF_LAYOUT_STORAGE_KEY)
    return stored === 'stacked' || stored === 'split' ? stored : 'split'
  } catch {
    return 'split'
  }
}

type DiffSummary = { status: DiffStatus, additions: number, deletions: number }

const EMPTY_SUMMARY: DiffSummary = { status: 'Unchanged', additions: 0, deletions: 0 }

const layoutButtonClass = (active: boolean, disabled = false) => (
  `inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border transition-colors ${
    active
      ? 'border-transparent bg-transparent text-kumo-brand'
      : 'border-transparent text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
  } ${disabled ? 'cursor-not-allowed opacity-35 hover:bg-transparent hover:text-kumo-subtle' : 'cursor-pointer'}`
)

export default function CodeDiffEditor({
  filename,
  original,
  text = null,
  session,
  readOnly = false,
  height = '100%',
}: CodeDiffEditorProps) {
  const { resolvedThemeMode } = useTheme()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const modifiedHostRef = useRef<HTMLDivElement | null>(null)
  const originalHostRef = useRef<HTMLDivElement | null>(null)
  const modifiedViewRef = useRef<EditorView | null>(null)
  const originalViewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const originalThemeCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const wrapCompartment = useRef(new Compartment())

  const sessionRef = useRef(session)
  sessionRef.current = session
  const sessionKey = session?.key
  const textRef = useRef(text)
  textRef.current = text
  const originalRef = useRef(original)
  originalRef.current = original
  const themeModeRef = useRef(resolvedThemeMode)
  themeModeRef.current = resolvedThemeMode
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly

  const [canSplitDiff, setCanSplitDiff] = useState(false)
  // Phone-width containers get a word-wrapped chat-side editor (see the wrap compartment below).
  const [isCompact, setIsCompact] = useState(false)
  const isCompactRef = useRef(isCompact)
  isCompactRef.current = isCompact
  const [diffLayoutPreference, setDiffLayoutPreference] =
    useState<DiffLayoutPreference>(getInitialDiffLayoutPreference)
  const splitDiff = canSplitDiff && diffLayoutPreference === 'split'
  const splitDiffRef = useRef(splitDiff)
  splitDiffRef.current = splitDiff

  // Deletion-block keys the user has expanded past truncation.
  const [expandedDeletions, setExpandedDeletions] = useState<Set<string>>(new Set())
  const expandedRef = useRef<ReadonlySet<string>>(expandedDeletions)
  expandedRef.current = expandedDeletions
  const onExpandDeletion = useCallback((key: string) => {
    setExpandedDeletions(prev => {
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }, [])

  // The -N +N pill's data; the full model lives in a ref (it feeds the views directly).
  const [summary, setSummary] = useState<DiffSummary>(EMPTY_SUMMARY)
  const modelRef = useRef(buildDiffModel({
    original: '', modified: '', hasOriginal: false, hasModified: false,
  }))

  // Bumped when either view is (re)created, retriggering the scroll-sync wiring.
  const [viewsToken, setViewsToken] = useState(0)

  const showEditors =
    filename !== null && (original !== null || session !== undefined || text !== null)

  // ---- diff recompute (rAF-coalesced) --------------------------------------------------------

  const dispatchRender = useCallback(() => {
    const base = {
      model: modelRef.current,
      expandedDeletions: expandedRef.current,
      onExpandDeletion,
    }
    modifiedViewRef.current?.dispatch({
      effects: setDiffRender.of({
        ...base, layout: splitDiffRef.current ? 'split' : 'stacked',
      }),
    })
    originalViewRef.current?.dispatch({
      effects: setDiffRender.of({ ...base, layout: 'split' }),
    })
  }, [onExpandDeletion])

  const recompute = useCallback(() => {
    const view = modifiedViewRef.current
    if (!view) return
    const activeSession = sessionRef.current
    const hasModified = activeSession
      ? activeSession.getText() !== undefined
      : textRef.current !== null
    const model = buildDiffModel({
      original: originalRef.current ?? '',
      modified: view.state.doc.toString(),
      hasOriginal: originalRef.current !== null,
      hasModified,
    })
    modelRef.current = model
    setSummary(prev =>
      prev.status === model.status && prev.additions === model.additions &&
        prev.deletions === model.deletions
        ? prev
        : { status: model.status, additions: model.additions, deletions: model.deletions })
    dispatchRender()
  }, [dispatchRender])

  const recomputeRafRef = useRef<number | null>(null)
  const scheduleRecompute = useCallback(() => {
    if (recomputeRafRef.current !== null) return
    recomputeRafRef.current = window.requestAnimationFrame(() => {
      recomputeRafRef.current = null
      recompute()
    })
  }, [recompute])
  useEffect(() => () => {
    if (recomputeRafRef.current !== null) {
      window.cancelAnimationFrame(recomputeRafRef.current)
      // Clear the id, not just the frame: StrictMode's simulated unmount runs this cleanup and
      // then remounts the same component instance (refs intact), so a canceled id left behind
      // would make every future scheduleRecompute() think a frame is still pending -- freezing
      // the diff at its mount-time state.
      recomputeRafRef.current = null
    }
  }, [])

  // ---- editors -------------------------------------------------------------------------------

  // Shared base for both sides. No folding, and no line wrapping here: the split layout's
  // alignment relies on one line per 20px. (The chat side alone word-wraps at phone widths via
  // the wrap compartment -- compact widths are far below the split gate, so alignment never
  // coexists with wrapping.)
  const baseExtensions = useCallback((forFilename: string): Extension[] => [
    // Split documents only on "\n"; see CodeEditor for why this matters to the OT stream.
    EditorState.lineSeparator.of('\n'),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    bracketMatching(),
    highlightSelectionMatches(),
    indentUnit.of('  '),
    EditorState.tabSize.of(2),
    getLanguage(forFilename),
  ], [])

  // (Re)build the chat-side editor when the document's identity changes: the file, the session
  // (or its key -- a chat switch or client rebuild), or the absence of one.
  useEffect(() => {
    const host = modifiedHostRef.current
    if (!host || filename === null || !showEditors) return

    const doc = session ? (session.getText() ?? '') : (text ?? '')
    const extensions: Extension[] = [
      // Before lineNumbers so the change-bar gutter renders leftmost.
      diffRenderExtension('modified'),
      lineNumbers(),
      history(),
      indentOnInput(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      ...baseExtensions(filename),
      themeCompartment.current.of(codeEditorTheme(themeModeRef.current)),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(readOnlyRef.current || !session),
        EditorView.editable.of(!readOnlyRef.current && !!session),
      ]),
      wrapCompartment.current.of(isCompactRef.current ? EditorView.lineWrapping : []),
      EditorView.updateListener.of(update => {
        if (update.docChanged) scheduleRecompute()
      }),
    ]
    if (session) {
      extensions.push(sessionChangeListener(() => sessionRef.current))
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions }),
    })
    modifiedViewRef.current = view

    const unsubscribeRemote = session ? connectSessionRemote(view, session) : undefined
    // Changes that don't change this document (e.g. deleting an already-empty file) still flip the
    // model's has-modified flag; the doc-change listener alone would miss them.
    const unsubscribeRecompute = session?.subscribeRemote(() => scheduleRecompute())

    setViewsToken(token => token + 1)
    recompute()

    return () => {
      unsubscribeRemote?.()
      unsubscribeRecompute?.()
      view.destroy()
      modifiedViewRef.current = null
    }
    // `session` identity may change per render (sessionKey captures the real identity), and
    // `text` only matters at build time in session mode; the sync effect below tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, sessionKey, session === undefined, showEditors])

  // The original-side editor exists only in the split layout.
  useEffect(() => {
    const host = originalHostRef.current
    if (!host || filename === null || !showEditors || !splitDiff) return

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: original ?? '',
        extensions: [
          diffRenderExtension('original'),
          lineNumbers(),
          keymap.of([...defaultKeymap, ...searchKeymap]),
          ...baseExtensions(filename),
          originalThemeCompartment.current.of(codeEditorTheme(themeModeRef.current)),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    })
    originalViewRef.current = view

    setViewsToken(token => token + 1)
    dispatchRender()

    return () => {
      view.destroy()
      originalViewRef.current = null
    }
    // `original` only matters at build time; the sync effect below tracks it in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, splitDiff, showEditors])

  // Track prop changes in place (no state rebuild, keeps scroll position).
  useEffect(() => {
    const view = originalViewRef.current
    if (view) setDocText(view, original ?? '')
    scheduleRecompute()
  }, [original, scheduleRecompute])
  useEffect(() => {
    const view = modifiedViewRef.current
    if (!view || session !== undefined) return
    setDocText(view, text ?? '')
  }, [text, session])

  // Layout and expansion changes re-render the existing model without re-diffing.
  useEffect(() => {
    dispatchRender()
  }, [splitDiff, expandedDeletions, dispatchRender])

  // Theme and read-only flips reconfigure in place.
  useEffect(() => {
    const theme = codeEditorTheme(resolvedThemeMode)
    modifiedViewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(theme),
    })
    originalViewRef.current?.dispatch({
      effects: originalThemeCompartment.current.reconfigure(theme),
    })
  }, [resolvedThemeMode, viewsToken])
  useEffect(() => {
    modifiedViewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly || !session),
        EditorView.editable.of(!readOnly && !!session),
      ]),
    })
  }, [readOnly, session === undefined])
  useEffect(() => {
    modifiedViewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(isCompact ? EditorView.lineWrapping : []),
    })
  }, [isCompact, viewsToken])

  // Reset expansion state on file switch.
  useEffect(() => {
    setExpandedDeletions(new Set())
  }, [filename, sessionKey])

  // ---- layout: width gating, preference, scroll sync ------------------------------------------

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const update = (width: number) => {
      setCanSplitDiff(width >= SPLIT_DIFF_MIN_WIDTH)
      setIsCompact(width < 640)
    }
    update(container.getBoundingClientRect().width)

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) update(entry.contentRect.width)
    })
    observer.observe(container)

    return () => observer.disconnect()
  }, [filename, showEditors])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_LAYOUT_STORAGE_KEY, diffLayoutPreference)
    } catch {
      // Ignore storage failures; the control still works for the current session.
    }
  }, [diffLayoutPreference])

  // Bidirectional scrollTop sync between the two sides (their heights match line for line
  // thanks to the blank zones).
  useEffect(() => {
    if (!splitDiff) return
    const modified = modifiedViewRef.current
    const originalView = originalViewRef.current
    if (!modified || !originalView) return

    let syncing = false
    const syncScroll = (from: EditorView, to: EditorView) => {
      const handler = () => {
        if (syncing) return
        syncing = true
        to.scrollDOM.scrollTop = from.scrollDOM.scrollTop
        syncing = false
      }
      from.scrollDOM.addEventListener('scroll', handler)
      return () => from.scrollDOM.removeEventListener('scroll', handler)
    }

    const detachModified = syncScroll(modified, originalView)
    const detachOriginal = syncScroll(originalView, modified)
    originalView.scrollDOM.scrollTop = modified.scrollDOM.scrollTop

    return () => {
      detachModified()
      detachOriginal()
    }
  }, [splitDiff, viewsToken])

  // ---- render --------------------------------------------------------------------------------

  if (!showEditors) {
    return (
      <div
        className="flex items-center justify-center bg-kumo-base text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle"
        style={{ height }}
      >
        {!filename ? 'Select a file to view changes' : 'Loading diff...'}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex min-h-0 overflow-hidden bg-kumo-base" style={{ height }}>
      <div
        className="gadgets-diff-surface relative min-h-0 flex-1 overflow-hidden bg-kumo-base md:m-4 md:rounded-[10px] md:border md:border-kumo-line"
        style={{ isolation: 'isolate' }}
      >
        <div className="absolute right-3 top-3 flex items-center gap-2" style={{ zIndex: 1 }}>
          <div className="flex h-7 items-center gap-0.5 rounded-lg border border-kumo-line bg-kumo-base px-0.5 shadow-sm">
            <button
              type="button"
              className={layoutButtonClass(diffLayoutPreference === 'stacked')}
              title="Stacked diff"
              aria-label="Use stacked diff layout"
              aria-pressed={diffLayoutPreference === 'stacked'}
              onClick={() => setDiffLayoutPreference('stacked')}
            >
              <Rows size={15} weight="regular" />
            </button>
            <button
              type="button"
              className={layoutButtonClass(diffLayoutPreference === 'split' && canSplitDiff, !canSplitDiff)}
              title={canSplitDiff ? 'Split diff' : 'Split diff needs more space'}
              aria-label="Use split diff layout"
              aria-pressed={diffLayoutPreference === 'split' && canSplitDiff}
              disabled={!canSplitDiff}
              onClick={() => setDiffLayoutPreference('split')}
            >
              <Columns size={15} weight="regular" />
            </button>
          </div>
          <div
            className="pointer-events-none flex h-7 items-center gap-2 rounded-lg border border-kumo-line bg-kumo-base px-2 font-mono text-[11px] leading-4 tracking-[-0.2px] shadow-sm"
            style={{ fontFamily: monoFont }}
          >
            {summary.status !== 'Modified' && (
              <span className="text-[10px] font-medium text-kumo-subtle">{summary.status}</span>
            )}
            <span className="text-kumo-danger">-{summary.deletions}</span>
            <span className="text-kumo-success">+{summary.additions}</span>
          </div>
        </div>

        <div className={splitDiff ? 'flex h-full min-h-0' : 'h-full min-h-0'}>
          {splitDiff && (
            <div
              key="original"
              ref={originalHostRef}
              className="cm-editor-host h-full min-w-0 flex-1 overflow-hidden"
              style={{ fontFamily: monoFont }}
            />
          )}
          {splitDiff && <div key="divider" className="w-px flex-shrink-0 bg-kumo-line" />}
          <div
            key="modified"
            ref={modifiedHostRef}
            className={`cm-editor-host min-w-0 overflow-hidden ${splitDiff ? 'h-full flex-1' : 'h-full'}`}
            style={{ fontFamily: monoFont }}
          />
        </div>
      </div>
    </div>
  )
}
