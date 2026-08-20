import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Editor } from '@monaco-editor/react'
import { Columns, Rows } from '@phosphor-icons/react'
import type { editor } from 'monaco-editor'
import type * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import { defineGadgetsCodeTheme, getGadgetsCodeTheme, monoFont } from './components/monacoTheme'
import { buildDiffModel, type DiffModel } from './diff/diffModel'
import { renderDiffLayer, renderSplitDiffLayer } from './diff/diffRenderer'
import { getLanguage } from './getLanguage'
import { useTheme } from './ThemeContext'
import './CodeDiffEditor.css'

interface CodeDiffEditorProps {
  filename: string | null
  originalYText: Y.Text | null
  modifiedYText: Y.Text | null
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

/**
 * Unified diff editor.
 *
 * 1. A visible Monaco editor shows the modified file, bound to
 *    `modifiedYText` via y-monaco.
 * 2. An offscreen Monaco DiffEditor computes `ILineChange[]`. Models are
 *    swapped in-place; the editor is never recreated while mounted.
 * 3. `buildDiffModel` (in ./diff/diffModel) converts line changes into a
 *    flat list of `ChangeRun`s.
 * 4. `renderDiffLayer` (in ./diff/diffRenderer) applies decorations and
 *    view zones (red deletion blocks above modified lines).
 */

export default function CodeDiffEditor({
  filename,
  originalYText,
  modifiedYText,
  readOnly = false,
  height = '100%',
}: CodeDiffEditorProps) {
  const { resolvedThemeMode } = useTheme()
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const originalEditorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const bindingRef = useRef<MonacoBinding | null>(null)
  const decorationCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const originalDecorationCollectionRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<readonly string[]>([])
  const originalViewZoneIdsRef = useRef<readonly string[]>([])
  // Single offscreen DiffEditor shared across the component's lifetime.
  const offscreenRef = useRef<{
    container: HTMLElement
    diffEditor: editor.IStandaloneDiffEditor
    listener: { dispose(): void }
  } | null>(null)

  const [editorReady, setEditorReady] = useState(false)
  const [originalEditorReady, setOriginalEditorReady] = useState(false)
  const [editorMountVersion, setEditorMountVersion] = useState(0)
  const [originalEditorMountVersion, setOriginalEditorMountVersion] = useState(0)
  const [canSplitDiff, setCanSplitDiff] = useState(false)
  const [isCompact, setIsCompact] = useState(false)
  const [diffLayoutPreference, setDiffLayoutPreference] = useState<DiffLayoutPreference>(getInitialDiffLayoutPreference)
  const [yjsVersion, setYjsVersion] = useState(0)
  const [lineChanges, setLineChanges] = useState<editor.ILineChange[] | null>(null)
  // Deletion-block keys the user has expanded past truncation.
  const [expandedDeletions, setExpandedDeletions] = useState<Set<string>>(new Set())
  const splitDiff = canSplitDiff && diffLayoutPreference === 'split'
  const codeTheme = getGadgetsCodeTheme(resolvedThemeMode)

  const originalValue = useMemo(
    () => originalYText?.toString() ?? '',
    [originalYText, yjsVersion],
  )
  const modifiedValue = useMemo(
    () => modifiedYText?.toString() ?? '',
    [modifiedYText, yjsVersion],
  )

  // Bump `yjsVersion` on each Yjs update so `originalValue`/`modifiedValue`
  // memos reread `.toString()`. Coalesced on rAF to avoid a setState per keystroke.
  useEffect(() => {
    let raf: number | null = null
    const bump = () => {
      if (raf !== null) return
      raf = window.requestAnimationFrame(() => {
        raf = null
        setYjsVersion(v => v + 1)
      })
    }

    originalYText?.observe(bump)
    modifiedYText?.observe(bump)

    return () => {
      originalYText?.unobserve(bump)
      modifiedYText?.unobserve(bump)
      if (raf !== null) window.cancelAnimationFrame(raf)
    }
  }, [originalYText, modifiedYText])

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
  }, [filename, originalYText, modifiedYText])

  useEffect(() => {
    try {
      window.localStorage.setItem(DIFF_LAYOUT_STORAGE_KEY, diffLayoutPreference)
    } catch {
      // Ignore storage failures; the control still works for the current session.
    }
  }, [diffLayoutPreference])

  useEffect(() => {
    if (splitDiff) return
    originalDecorationCollectionRef.current?.clear()
    originalViewZoneIdsRef.current = []
    originalEditorRef.current = null
    setOriginalEditorReady(false)
  }, [splitDiff])

  // Reset expansion state on file switch.
  useEffect(() => {
    setExpandedDeletions(new Set())
    setLineChanges(null)
  }, [filename, originalYText, modifiedYText])

  // Offscreen diff engine: created once per editor instance; models are
  // swapped in-place when the language changes.
  useEffect(() => {
    const monaco = monacoRef.current
    if (!monaco || !editorReady) return
    if (offscreenRef.current) return

    const container = document.createElement('div')
    container.style.cssText =
      'position:absolute;left:-10000px;top:-10000px;width:800px;height:600px;' +
      'opacity:0;pointer-events:none;'
    document.body.append(container)

    const diffEditor = monaco.editor.createDiffEditor(container, {
      automaticLayout: false,
      renderSideBySide: false,
      readOnly: true,
      minimap: { enabled: false },
    })
    const listener = diffEditor.onDidUpdateDiff(() => {
      setLineChanges(diffEditor.getLineChanges() ?? [])
    })

    offscreenRef.current = { container, diffEditor, listener }

    return () => {
      const current = offscreenRef.current
      offscreenRef.current = null
      if (!current) return
      current.listener.dispose()
      const m = current.diffEditor.getModel()
      current.diffEditor.dispose()
      m?.original.dispose()
      m?.modified.dispose()
      current.container.remove()
    }
  }, [editorReady])

  useEffect(() => {
    const monaco = monacoRef.current
    const offscreen = offscreenRef.current?.diffEditor
    if (!monaco || !offscreen || !editorReady || !originalYText || !modifiedYText) {
      setLineChanges(null)
      return
    }

    const language = filename ? getLanguage(filename) : 'plaintext'
    const existing = offscreen.getModel()

    if (existing && existing.original.getLanguageId() === language) {
      if (existing.original.getValue() !== originalValue) existing.original.setValue(originalValue)
      if (existing.modified.getValue() !== modifiedValue) existing.modified.setValue(modifiedValue)
      return
    }

    const original = monaco.editor.createModel(originalValue, language)
    const modified = monaco.editor.createModel(modifiedValue, language)
    offscreen.setModel({ original, modified })
    existing?.original.dispose()
    existing?.modified.dispose()
  }, [editorReady, filename, originalValue, modifiedValue, originalYText, modifiedYText])

  const model: DiffModel = useMemo(() => buildDiffModel({
    original: originalValue,
    modified: modifiedValue,
    hasOriginal: !!originalYText,
    hasModified: !!modifiedYText,
    lineChanges,
  }), [originalValue, modifiedValue, originalYText, modifiedYText, lineChanges])

  useEffect(() => {
    const ed = editorRef.current
    if (!ed || !editorReady) return

    bindingRef.current?.destroy()
    bindingRef.current = null

    const editorModel = ed.getModel()
    if (!editorModel) return

    if (modifiedYText) {
      bindingRef.current = new MonacoBinding(modifiedYText, editorModel, new Set([ed]))
    } else {
      editorModel.setValue('')
    }

    return () => {
      bindingRef.current?.destroy()
      bindingRef.current = null
    }
  }, [modifiedYText, editorReady, editorMountVersion])

  useEffect(() => {
    const ed = originalEditorRef.current
    if (!ed || !originalEditorReady) return

    const editorModel = ed.getModel()
    if (!editorModel) return

    const nextValue = originalYText ? originalValue : ''
    if (editorModel.getValue() !== nextValue) editorModel.setValue(nextValue)
  }, [originalEditorReady, originalEditorMountVersion, originalValue, originalYText])

  useEffect(() => {
    const ed = editorRef.current
    const monaco = monacoRef.current
    if (!ed || !monaco || !editorReady) return

    if (splitDiff) {
      viewZoneIdsRef.current = renderSplitDiffLayer({
        editor: ed,
        monaco,
        model,
        side: 'modified',
        decorationCollection: decorationCollectionRef.current,
        previousViewZoneIds: viewZoneIdsRef.current,
      })
      if (originalEditorReady && originalEditorRef.current) {
        originalViewZoneIdsRef.current = renderSplitDiffLayer({
          editor: originalEditorRef.current,
          monaco,
          model,
          side: 'original',
          decorationCollection: originalDecorationCollectionRef.current,
          previousViewZoneIds: originalViewZoneIdsRef.current,
        })
      }
      return
    }

    viewZoneIdsRef.current = renderDiffLayer({
      editor: ed,
      monaco,
      model,
      expandedDeletions,
      decorationCollection: decorationCollectionRef.current,
      previousViewZoneIds: viewZoneIdsRef.current,
      onExpandDeletion: deletionKey => {
        setExpandedDeletions(prev => {
          const next = new Set(prev)
          next.add(deletionKey)
          return next
        })
      },
    })
  }, [model, editorReady, originalEditorReady, editorMountVersion, originalEditorMountVersion, splitDiff, expandedDeletions])

  useEffect(() => {
    return () => {
      decorationCollectionRef.current?.clear()
      originalDecorationCollectionRef.current?.clear()
      bindingRef.current?.destroy()
    }
  }, [])

  const handleEditorDidMount = useCallback((
    ed: editor.IStandaloneCodeEditor,
    monaco: typeof import('monaco-editor'),
  ) => {
    editorRef.current = ed
    monacoRef.current = monaco
    decorationCollectionRef.current = ed.createDecorationsCollection()
    setEditorReady(true)
    setEditorMountVersion(v => v + 1)
  }, [])

  const handleOriginalEditorDidMount = useCallback((
    ed: editor.IStandaloneCodeEditor,
    monaco: typeof import('monaco-editor'),
  ) => {
    originalEditorRef.current = ed
    monacoRef.current = monaco
    originalDecorationCollectionRef.current = ed.createDecorationsCollection()
    setOriginalEditorReady(true)
    setOriginalEditorMountVersion(v => v + 1)
  }, [])

  useEffect(() => {
    if (!splitDiff || !editorReady || !originalEditorReady) return
    const modified = editorRef.current
    const original = originalEditorRef.current
    if (!modified || !original) return

    let syncing = false
    const syncScroll = (from: editor.IStandaloneCodeEditor, to: editor.IStandaloneCodeEditor) => (
      from.onDidScrollChange(event => {
        if (syncing || !event.scrollTopChanged) return
        syncing = true
        to.setScrollTop(event.scrollTop)
        syncing = false
      })
    )

    const modifiedListener = syncScroll(modified, original)
    const originalListener = syncScroll(original, modified)
    original.setScrollTop(modified.getScrollTop())

    return () => {
      modifiedListener.dispose()
      originalListener.dispose()
    }
  }, [splitDiff, editorReady, originalEditorReady, editorMountVersion, originalEditorMountVersion])

  const commonEditorOptions = useMemo((): editor.IStandaloneEditorConstructionOptions => ({
    automaticLayout: true,
    fontSize: 13,
    lineHeight: 20,
    letterSpacing: 0,
    fontFamily: monoFont,
    fontLigatures: false,
    minimap: { enabled: false },
    wordWrap: isCompact ? 'on' : 'off',
    scrollBeyondLastLine: false,
    renderLineHighlight: 'none',
    selectOnLineNumbers: true,
    roundedSelection: false,
    cursorStyle: 'line',
    glyphMargin: false,
    folding: false,
    lineDecorationsWidth: isCompact ? 8 : 12,
    lineNumbersMinChars: isCompact ? 3 : 4,
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    renderValidationDecorations: 'editable',
    renderWhitespace: 'none',
    renderFinalNewline: 'off',
    renderLineHighlightOnlyWhenFocus: true,
    padding: { top: 12, bottom: 16 },
    guides: { indentation: false, highlightActiveIndentation: false },
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
    tabSize: 2,
    insertSpaces: true,
    contextmenu: true,
    mouseWheelZoom: false,
  }), [isCompact])

  const layoutButtonClass = (active: boolean, disabled = false) => (
    `inline-flex h-[22px] w-[22px] items-center justify-center rounded-md border transition-colors ${
      active
        ? 'border-transparent bg-transparent text-kumo-brand'
        : 'border-transparent text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
    } ${disabled ? 'cursor-not-allowed opacity-35 hover:bg-transparent hover:text-kumo-subtle' : 'cursor-pointer'}`
  )

  if (!filename || (!originalYText && !modifiedYText)) {
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
            {model.status !== 'Modified' && (
              <span className="text-[10px] font-medium text-kumo-subtle">{model.status}</span>
            )}
            <span className="text-kumo-danger">-{model.deletions}</span>
            <span className="text-kumo-success">+{model.additions}</span>
          </div>
        </div>

        <div className={splitDiff ? 'flex h-full min-h-0' : 'h-full min-h-0'}>
          {splitDiff && (
            <div key="original" className="min-w-0 flex-1">
              <Editor
                height="100%"
                language={getLanguage(filename)}
                defaultValue=""
                beforeMount={defineGadgetsCodeTheme}
                onMount={handleOriginalEditorDidMount}
                theme={codeTheme}
                options={{
                  ...commonEditorOptions,
                  readOnly: true,
                  domReadOnly: true,
                  scrollbar: {
                    ...commonEditorOptions.scrollbar,
                    vertical: 'hidden',
                    alwaysConsumeMouseWheel: false,
                  },
                }}
              />
            </div>
          )}
          {splitDiff && <div key="divider" className="w-px flex-shrink-0 bg-kumo-line" />}
          <div key="modified" className={splitDiff ? 'min-w-0 flex-1' : 'h-full min-w-0'}>
            <Editor
              height="100%"
              language={getLanguage(filename)}
              defaultValue=""
              beforeMount={defineGadgetsCodeTheme}
              onMount={handleEditorDidMount}
              theme={codeTheme}
              options={{
                ...commonEditorOptions,
                readOnly: readOnly || !modifiedYText,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
