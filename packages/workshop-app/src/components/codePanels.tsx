import { useEffect, useReducer, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ArrowDownIcon, ArrowUpIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { EditorSelection, StateEffect, StateField, type EditorState } from '@codemirror/state'
import { EditorView, showPanel, type Panel, type ViewUpdate } from '@codemirror/view'
import {
  closeSearchPanel, findNext, findPrevious, getSearchQuery, search, SearchQuery, setSearchQuery,
} from '@codemirror/search'

// The editor's panels (find, go to line) drawn by React in the app's own controls, rather than
// CodeMirror's form, and floated over the code at its top end by the theme (`.cm-panels-top`).

type Listener = () => void

// A panel's React tree, told when the editor changes, and taken down with the panel.
const reactPanel = (view: EditorView, render: (view: EditorView, subscribe: (listener: Listener) => () => void) => ReactNode): Panel => {
  const dom = document.createElement('div')
  const listeners = new Set<Listener>()
  let root: Root | undefined
  return {
    dom,
    top: true,
    mount() {
      root = createRoot(dom)
      root.render(render(view, (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }))
    },
    update(_update: ViewUpdate) {
      for (const listener of listeners) listener()
    },
    destroy() {
      // Unmounted after CodeMirror is done with the update that removed it.
      const done = root
      queueMicrotask(() => done?.unmount())
    },
  }
}

// Re-renders a panel's component when the editor changes.
const useEditorChanges = (subscribe: (listener: Listener) => () => void) => {
  const [, changed] = useReducer((count: number) => count + 1, 0)
  useEffect(() => subscribe(changed), [subscribe])
}

/** Past this many, matches are counted as "1000+": counting on would hold up typing. */
const MOST_COUNTED = 1000

/** Where the current match is among them all, and how many there are. */
const matchCount = (state: EditorState, query: SearchQuery): { current: number; total: number } => {
  if (!query.valid || !query.search) return { current: 0, total: 0 }
  const cursor = query.getCursor(state)
  const { from, to } = state.selection.main
  let total = 0
  let current = 0
  for (let next = cursor.next(); !next.done && total < MOST_COUNTED; next = cursor.next()) {
    total += 1
    if (next.value.from === from && next.value.to === to) current = total
  }
  return { current, total }
}

const COUNT = new Intl.NumberFormat('en')

// A small square toggle in the field, as the editors engineers know have for each way of matching.
const Toggle = ({ on, label, onToggle, children }: { on: boolean; label: string; onToggle: () => void; children: ReactNode }) => (
  <button
    type="button"
    aria-label={label}
    aria-pressed={on}
    title={label}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onToggle}
    className={cn(
      'grid h-6 min-w-6 cursor-pointer place-items-center rounded-md px-1 font-mono text-[11px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
      on ? 'bg-kumo-brand/14 text-kumo-default ring-1 ring-kumo-brand/40' : 'text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default',
    )}
  >
    {children}
  </button>
)

const IconButton = ({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onMouseDown={(event) => event.preventDefault()}
    onClick={onClick}
    className="grid size-7 cursor-pointer place-items-center rounded-full text-kumo-subtle outline-none hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:pointer-events-none disabled:opacity-40 [&>svg]:size-3.5"
  >
    {children}
  </button>
)

// The pill both panels are drawn on: raised off the code, as a menu is off the page.
const BAR = 'appears flex h-10 items-center gap-1 rounded-full bg-kumo-base ps-3.5 pe-1.5 text-sm text-kumo-default shadow-lg ring-1 ring-kumo-line'

const FindBar = ({ view, subscribe }: { view: EditorView; subscribe: (listener: Listener) => () => void }) => {
  useEditorChanges(subscribe)
  const query = getSearchQuery(view.state)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])
  const change = (next: Partial<ConstructorParameters<typeof SearchQuery>[0]>) => {
    const made = new SearchQuery({ search: query.search, caseSensitive: query.caseSensitive, regexp: query.regexp, wholeWord: query.wholeWord, ...next })
    view.dispatch({ effects: setSearchQuery.of(made) })
    // As it is typed, the first match from where the code was being read is found.
    if (next.search !== undefined || next.caseSensitive !== undefined || next.regexp !== undefined || next.wholeWord !== undefined) {
      const cursor = made.getCursor(view.state, view.state.selection.main.from)
      const found = cursor.next()
      if (!found.done) view.dispatch({ selection: EditorSelection.single(found.value.from, found.value.to), scrollIntoView: true })
    }
  }
  const { current, total } = matchCount(view.state, query)
  const invalid = query.search !== '' && !query.valid
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) findPrevious(view)
      else findNext(view)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeSearchPanel(view)
      view.focus()
    }
  }
  return (
    <div role="search" aria-label="Find in this file" className={cn(BAR, 'w-[min(26rem,calc(100cqw-1.5rem))]')}>
      <input
        ref={input}
        main-field="true"
        aria-label="Find"
        placeholder="Find"
        spellCheck={false}
        autoComplete="off"
        value={query.search}
        onChange={(event) => change({ search: event.target.value })}
        onKeyDown={keyDown}
        aria-invalid={invalid || undefined}
        className={cn('min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-kumo-subtle', invalid && 'text-kumo-danger')}
      />
      <span aria-live="polite" className="shrink-0 px-1 text-xs text-kumo-subtle tabular-nums">
        {query.search === '' ? '' : invalid ? 'Not a pattern' : total === 0 ? 'No results' : `${current ? COUNT.format(current) : '–'} of ${total >= MOST_COUNTED ? '1000+' : COUNT.format(total)}`}
      </span>
      <span className="flex shrink-0 items-center gap-0.5">
        <Toggle on={query.caseSensitive} label="Match case" onToggle={() => change({ caseSensitive: !query.caseSensitive })}>Aa</Toggle>
        <Toggle on={query.wholeWord} label="Match whole word" onToggle={() => change({ wholeWord: !query.wholeWord })}><span className="underline decoration-1 underline-offset-2">ab</span></Toggle>
        <Toggle on={query.regexp} label="Use a regular expression" onToggle={() => change({ regexp: !query.regexp })}>.*</Toggle>
      </span>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-kumo-line" />
      <IconButton label="Previous match (Shift Enter)" disabled={total === 0} onClick={() => findPrevious(view)}><ArrowUpIcon weight="bold" /></IconButton>
      <IconButton label="Next match (Enter)" disabled={total === 0} onClick={() => findNext(view)}><ArrowDownIcon weight="bold" /></IconButton>
      <IconButton label="Close (Escape)" onClick={() => { closeSearchPanel(view); view.focus() }}><XIcon weight="bold" /></IconButton>
    </div>
  )
}

/** Find within the file, from Cmd or Ctrl with F, in the app's own bar. */
export const codeFind = search({ top: true, createPanel: (view) => reactPanel(view, (editor, subscribe) => <FindBar view={editor} subscribe={subscribe} />) })

// Go to line: open or not, as the editor's state.
const toggleGoTo = StateEffect.define<boolean>()
const goToOpen = StateField.define<boolean>({
  create: () => false,
  update: (open, transaction) => transaction.effects.reduce((was, effect) => (effect.is(toggleGoTo) ? effect.value : was), open),
  provide: (field) => showPanel.from(field, (open) => (open ? (view) => reactPanel(view, (editor) => <GoToBar view={editor} />) : null)),
})

const GoToBar = ({ view }: { view: EditorView }) => {
  const lines = view.state.doc.lines
  const [value, setValue] = useState('')
  const close = () => {
    view.dispatch({ effects: toggleGoTo.of(false) })
    view.focus()
  }
  // "12" or "12:4", a line and a column on it, as editors take them.
  const parsed = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(value)
  const line = parsed ? Math.min(Math.max(Number(parsed[1]), 1), lines) : undefined
  const go = () => {
    if (line === undefined || !parsed) return
    const at = view.state.doc.line(line)
    const column = parsed[2] ? Math.min(Number(parsed[2]) - 1, at.length) : 0
    view.dispatch({ selection: EditorSelection.cursor(at.from + Math.max(column, 0)), effects: [toggleGoTo.of(false), EditorView.scrollIntoView(at.from, { y: 'center' })] })
    view.focus()
  }
  return (
    <form role="search" aria-label="Go to line" onSubmit={(event) => { event.preventDefault(); go() }} className={cn(BAR, 'w-64')}>
      <input
        autoFocus
        inputMode="numeric"
        aria-label="Line"
        placeholder={`Line, 1 to ${COUNT.format(lines)}`}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); close() } }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[13px] tabular-nums outline-none placeholder:font-sans placeholder:text-kumo-subtle"
      />
      <IconButton label="Close (Escape)" onClick={close}><XIcon weight="bold" /></IconButton>
    </form>
  )
}

/** Opens Go to line, which Ctrl with G also does. */
export const openGoToLine = (view: EditorView) => {
  view.dispatch({ effects: toggleGoTo.of(true) })
  return true
}

/** Go to a line, and a column on it, from Ctrl with G, in the app's own bar. */
export const codeGoToLine = goToOpen
