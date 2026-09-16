import { useEffect, useRef } from 'react'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
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
import type { FileChange, TextChange } from '@gadgets/workshop-shared/code-change'
import { codeEditorTheme, monoFont } from './components/codeTheme'
import { getLanguage } from './getLanguage'
import { useTheme } from './ThemeContext'

// The code view's plain editor: CodeMirror 6, either read-only (the committed head view) or
// bound to the chat's OT client through an EditSession. In-chat diff presentation lives in
// CodeDiffEditor, which reuses this module's session wiring.

/**
 * An editable file's connection to the chat's OT client (see GadgetCodeInterface): the editor
 * reads the initial text, pushes locally-authored changes, and receives remote deltas. `key`
 * identifies the document's identity -- when it changes, the editor rebuilds its state from
 * getText() (chat/file switches, client rebuilds); while it is stable, the text evolves only
 * through this editor's own edits and the remote changes delivered to `subscribeRemote`.
 */
export interface EditSession {
  key: string
  getText(): string | undefined
  /** Push one locally-authored change. `docText` is the document's full text after the change. */
  applyLocal(change: FileChange, docText: string): void
  subscribeRemote(cb: (change: FileChange) => void): () => void
}

interface CodeEditorProps {
  filename: string | null
  /** The file's text when no session applies (read-only views). Ignored when session is set. */
  text?: string | null
  /** Editable OT-bound session; absent = read-only text view. */
  session?: EditSession
  readOnly?: boolean
  height?: string | number
}

// Marks transactions that apply remote (or programmatic) content, so the update listener
// doesn't feed them back into the session and undo history skips them.
const remoteChange = Annotation.define<boolean>()

/**
 * The local half of an EditSession binding: an update listener that pushes locally-authored
 * doc changes into the session (`getSession` is read per update, so the extension can be built
 * once against a ref).
 */
export function sessionChangeListener(getSession: () => EditSession | undefined): Extension {
  return EditorView.updateListener.of(update => {
    if (!update.docChanged) return
    if (update.transactions.every(tr => tr.annotation(remoteChange) !== true)) {
      getSession()?.applyLocal(
        { edit: update.changes.toJSON() as TextChange }, update.state.doc.toString())
    }
  })
}

/**
 * The remote half of an EditSession binding: streams the session's remote changes into the view as
 * annotated transactions (bypassing the local-edit listener and undo history). `set` covers
 * wholesale replacement (e.g. a newly-seeded base); `remove` clears the document so the view
 * doesn't show stale text a stray keystroke would silently resurrect. Returns an unsubscriber.
 */
export function connectSessionRemote(view: EditorView, session: EditSession): () => void {
  return session.subscribeRemote(change => {
    if ('edit' in change) {
      view.dispatch({
        changes: specFromTextChange(change.edit),
        annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
      })
    } else if ('set' in change) {
      if (view.state.doc.toString() !== change.set) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: change.set },
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        })
      }
    } else if ('remove' in change) {
      if (view.state.doc.length > 0) {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: '' },
          annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
        })
      }
    }
  })
}

/** Replace the whole document programmatically (annotated like a remote change). */
export function setDocText(view: EditorView, text: string) {
  if (view.state.doc.toString() !== text) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
    })
  }
}

export default function CodeEditor({
  filename, text = null, session, readOnly = false, height = '100%',
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
  // its key -- a chat switch or client rebuild), or the absence of one.
  useEffect(() => {
    const host = hostRef.current
    if (!host || filename === null) return

    const doc = session ? (session.getText() ?? '') : (text ?? '')
    const extensions: Extension[] = [
      // Split documents only on "\n" so CR and CRLF sequences survive the round trip: the OT
      // stream's changes are offsets into the exact stored text, and CodeMirror's default splitter
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
    if (session) {
      extensions.push(sessionChangeListener(() => sessionRef.current))
    }

    const view = new EditorView({
      parent: host,
      state: EditorState.create({ doc, extensions }),
    })
    viewRef.current = view

    const unsubscribe = session ? connectSessionRemote(view, session) : undefined

    return () => {
      unsubscribe?.()
      view.destroy()
      viewRef.current = null
    }
    // `session` object identity may change per render; sessionKey captures the real identity.
    // Likewise `text` only matters at build time in session mode; in read-only mode the sync
    // effect below tracks it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename, sessionKey, session === undefined])

  // Read-only views track the text prop in place (no state rebuild, keeps scroll position).
  useEffect(() => {
    const view = viewRef.current
    if (!view || session !== undefined) return
    setDocText(view, text ?? '')
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

// Convert a TextChange (ChangeSet compact JSON) into dispatchable change specs. Going through
// specs (rather than ChangeSet.fromJSON) sidesteps length-accounting differences if the doc
// briefly disagrees -- the specs clip nothing, and a mismatched length throws in dispatch,
// surfacing bugs rather than corrupting silently.
function specFromTextChange(change: TextChange): { from: number; to: number; insert: string }[] {
  const specs: { from: number; to: number; insert: string }[] = []
  let pos = 0
  for (const section of change) {
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
