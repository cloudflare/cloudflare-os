import { useEffect, useRef } from 'react'
import { Annotation, Compartment, EditorState, Text, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, drawSelection, dropCursor, highlightSpecialChars,
  rectangularSelection,
} from '@codemirror/view'
import {
  bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit,
} from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { unifiedMergeView } from '@codemirror/merge'
import type { FileOp, TextOp } from '@gadgets/workshop-shared/code-op'
import { codeEditorTheme, monoFont } from './components/codeTheme'
import { getLanguage } from './getLanguage'
import { useTheme } from './ThemeContext'

// The code view's editor: CodeMirror 6, either read-only (the committed head view) or bound to
// the chat's OT client through an EditSession. In a chat it doubles as the diff view: passing
// `original` (the committed side's text) layers @codemirror/merge's unified view over the same
// editable document, with inserted lines highlighted in place and deleted chunks shown inline.
// (This unified view is the interim diff presentation; a richer stacked/split rebuild is
// planned on the same foundation.)

/**
 * An editable file's connection to the chat's OT client (see GadgetCodeInterface): the editor
 * reads the initial text, pushes locally-authored ops, and receives remote deltas. `key`
 * identifies the document's identity -- when it changes, the editor rebuilds its state from
 * getText() (chat/file switches, client rebuilds); while it is stable, the text evolves only
 * through this editor's own edits and the remote ops delivered to `subscribeRemote`.
 */
export interface EditSession {
  key: string
  getText(): string | undefined
  /** Push one locally-authored op. `docText` is the document's full text after the op. */
  applyLocal(op: FileOp, docText: string): void
  subscribeRemote(cb: (op: FileOp) => void): () => void
}

interface CodeEditorProps {
  filename: string | null
  /** The file's text when no session applies (read-only views). Ignored when session is set. */
  text?: string | null
  /** Editable OT-bound session; absent = read-only text view. */
  session?: EditSession
  /** The committed ("original") text for the unified diff layer; undefined = no diff. */
  original?: string
  readOnly?: boolean
  height?: string | number
}

// Marks transactions that apply remote (or programmatic) content, so the update listener
// doesn't feed them back into the session and undo history skips them.
const remoteChange = Annotation.define<boolean>()

export default function CodeEditor({
  filename, text = null, session, original, readOnly = false, height = '100%',
}: CodeEditorProps) {
  const { resolvedThemeMode } = useTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const themeCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const sessionRef = useRef(session)
  sessionRef.current = session

  const sessionKey = session?.key
  const themeModeRef = useRef(resolvedThemeMode)
  themeModeRef.current = resolvedThemeMode
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly

  // (Re)build the editor whenever the document's identity changes: the file, the session (or
  // its key -- a chat switch or client rebuild), the diff base, or the absence of both.
  useEffect(() => {
    const host = hostRef.current
    if (!host || filename === null) return

    const doc = session ? (session.getText() ?? '') : (text ?? '')
    const extensions: Extension[] = [
      // Split documents only on "\n" so CR and CRLF sequences survive the round trip: the OT
      // stream's ops are offsets into the exact stored text, and CodeMirror's default splitter
      // would silently normalize other line endings away, desynchronizing the first edit.
      // (Stray \r characters render via highlightSpecialChars below.)
      EditorState.lineSeparator.of('\n'),
      lineNumbers(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      rectangularSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      EditorView.lineWrapping,
      indentUnit.of('  '),
      EditorState.tabSize.of(2),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, ...foldKeymap,
                 indentWithTab]),
      themeCompartment.current.of(codeEditorTheme(themeModeRef.current)),
      readOnlyCompartment.current.of([
        EditorState.readOnly.of(readOnlyRef.current || !session),
        EditorView.editable.of(!readOnlyRef.current && !!session),
      ]),
      getLanguage(filename),
    ]
    if (original !== undefined) {
      extensions.push(unifiedMergeView({
        // Split on "\n" only, mirroring the lineSeparator facet above: given a plain string,
        // the merge view would split it on /\r?\n/, silently dropping the CRs the document
        // side preserves and making every line of an unchanged CRLF file read as changed.
        original: Text.of(original.split('\n')),
        mergeControls: false,
        // Accepting/rejecting hunks is the accept-changes flow's job, not the editor's; the
        // gutter marker plus highlights are presentation only.
        highlightChanges: true,
        gutter: true,
      }))
    }
    if (session) {
      extensions.push(EditorView.updateListener.of(update => {
        if (!update.docChanged) return
        if (update.transactions.every(tr => tr.annotation(remoteChange) !== true)) {
          sessionRef.current?.applyLocal(
            { edit: update.changes.toJSON() as TextOp }, update.state.doc.toString())
        }
      }))
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions }),
    })
    viewRef.current = view

    // Remote ops stream in as deltas; `set` covers wholesale replacement (e.g. a newly-seeded
    // base). Both are annotated so they bypass the local-edit listener and undo history.
    const unsubscribe = session?.subscribeRemote(op => {
      if ('edit' in op) {
        view.dispatch({
          changes: specFromTextOp(op.edit),
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        })
      } else if ('set' in op) {
        if (view.state.doc.toString() !== op.set) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: op.set },
            annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
          })
        }
      } else if ('remove' in op) {
        // The file was deleted remotely: clear the document, so the diff view shows the
        // deletion (the merge view's original side carries the removed content) instead of
        // stale text that a stray keystroke would silently resurrect.
        if (view.state.doc.length > 0) {
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: '' },
            annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
          })
        }
      }
    })

    return () => {
      unsubscribe?.()
      view.destroy()
      viewRef.current = null
    }
    // `session` object identity may change per render; sessionKey captures the real identity.
    // Likewise `text` only matters at build time in session mode; in read-only mode the sync
    // effect below tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, sessionKey, session === undefined, original])

  // Read-only views track the text prop in place (no state rebuild, keeps scroll position).
  useEffect(() => {
    const view = viewRef.current
    if (!view || session !== undefined) return
    const next = text ?? ''
    if (view.state.doc.toString() !== next) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: next },
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      })
    }
  }, [text, session])

  // Theme and read-only flips reconfigure in place.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeCompartment.current.reconfigure(codeEditorTheme(resolvedThemeMode)),
    })
  }, [resolvedThemeMode])
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly || !session),
        EditorView.editable.of(!readOnly && !!session),
      ]),
    })
  }, [readOnly, session === undefined])

  if (!filename) {
    return (
      <div
        className="flex justify-center items-center bg-kumo-base text-kumo-subtle"
        style={{ height }}
      >
        Select a file to start editing
      </div>
    )
  }

  return (
    <div
      ref={hostRef}
      className="cm-editor-host h-full overflow-hidden"
      style={{ height, fontFamily: monoFont }}
    />
  )
}

// Convert a TextOp (ChangeSet compact JSON) into dispatchable change specs. Going through
// specs (rather than ChangeSet.fromJSON) sidesteps length-accounting differences if the doc
// briefly disagrees -- the specs clip nothing, and a mismatched length throws in dispatch,
// surfacing bugs rather than corrupting silently.
function specFromTextOp(op: TextOp): { from: number; to: number; insert: string }[] {
  const specs: { from: number; to: number; insert: string }[] = []
  let pos = 0
  for (const section of op) {
    if (typeof section === 'number') {
      pos += section
    } else {
      const [deleted, ...lines] = section
      specs.push({ from: pos, to: pos + deleted, insert: lines.join('\n') })
      pos += deleted
    }
  }
  return specs
}
