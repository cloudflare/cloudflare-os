import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import {
  ArrowLeftIcon, CheckIcon, ClockCounterClockwiseIcon, CopyIcon, DotsThreeIcon, DownloadSimpleIcon, LinkSimpleIcon, ListNumbersIcon,
  GitDiffIcon, MagnifyingGlassIcon, PlusIcon, SidebarSimpleIcon, TextAlignLeftIcon, WarningCircleIcon, XIcon,
} from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import type { CodeEditorHandle, CodeEditorStatus, CodeLines, CodeTextChange } from '@/components/CodeEditor'
import { CODE_LANGUAGE_NAMES } from '@/components/codeLanguages'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Markdown } from '@/components/Markdown'
import { codeLanguage } from '@/files/codeLanguage'
import { codePrefs, type CodePrefs } from '@/prefs/codePrefs'
import { changeLabel, CodeChangeList, CodeFileTree, editLabel, type CodeFileEditing, type CodeTreeEntry } from './CodeFileTree'
import { CodeFileStrip } from './CodeFileStrip'
import { CodeIconButton } from './CodeIconButton'
import { CodeQuickOpen } from './CodeQuickOpen'

// The editor and its languages load the first time code is shown: they are most of what it weighs.
const CodeEditor = lazy(() => import('@/components/CodeEditor').then((module) => ({ default: module.CodeEditor })))

/** One file of the code, as listed. */
export type CodeBrowserFile = CodeTreeEntry

/** A time the code was kept, as the history lists it. */
export type CodeBrowserCommit = {
  id: string
  /** Its message's first line. */
  summary: string
  /** Who kept it. */
  author?: string
  /** When, as the app says it: "5 min ago". */
  time?: string
}

/** What became of the last save of edits to the code. */
export type CodeBrowserSave =
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'failed'; message: string }
  /** Someone changed what was edited meanwhile, which saving would go over. */
  | { status: 'conflict'; message: string; onSaveAnyway: () => void; onDiscardMine: () => void }

/** Edits made as a draft, which is saved or discarded by hand. */
export type CodeBrowserDraft = {
  kind: 'draft'
  /** How many files the draft changes: none where there is no draft. */
  changes: number
  onSave: () => void
  onDiscard: () => void
  save?: CodeBrowserSave
}

/** Edits that go where the code is as they are made, as into the chat it is shown beside. */
export type CodeBrowserLive = {
  kind: 'live'
  /** Edits are on their way. */
  sending: boolean
  /** Edits that were lost, and why: refused, say, or discarded with the chat's changes. Until `onDismissLost`. */
  lost?: string
  onDismissLost: () => void
}

/**
 * The code typed in, and its files made, renamed, copied and deleted (`CodeFileEditing`): as a
 * draft (`CodeBrowserDraft`), or live (`CodeBrowserLive`). Out of use, with why, where it is
 * `blocked`, and while a past version is compared.
 */
export type CodeBrowserEditing = CodeFileEditing & {
  /** The file at `path`, as typed, with the edit typed. Says whether it was taken. */
  onEdit: (path: string, text: string, change: CodeTextChange) => boolean
  /** Each file's undo history is kept under this, with its path, while it stays the same. */
  historyKey?: string
  /** What was just done, for a screen reader to hear: "Renamed styles.css to theme.css". */
  said?: string
} & (CodeBrowserDraft | CodeBrowserLive)

export type CodeBrowserProps = {
  files:
    | { status: 'loading' }
    | { status: 'ready'; files: CodeBrowserFile[] }
    | { status: 'failed'; message: string }
  /** The path of the file shown. */
  shown?: string
  onShow: (path: string) => void
  file:
    | { status: 'loading' }
    | { status: 'text'; text: string }
    /** It has no text to show, and why. */
    | { status: 'other'; message: string }
    | { status: 'failed'; message: string }
  /**
   * The shown file before the change being looked at, to show it as the change: empty where it was
   * added. Where it is not a past version that is compared, a file that changed (`change`) is
   * shown as the change, and can be shown whole.
   */
  before?: { status: 'loading' } | { status: 'text'; text: string }
  /** Reads it all again, after it failed. */
  onRetry?: () => void
  /** What it says when there are no files. */
  empty?: ReactNode
  /**
   * Each time the code was kept, newest first, to look at what changed in it (`comparing`, its id),
   * or none to go back to the code as it is.
   */
  history?: {
    commits: { status: 'loading' } | { status: 'ready'; commits: CodeBrowserCommit[] } | { status: 'failed'; message: string }
    comparing?: string
    onCompare: (id: string | undefined) => void
  }
  /** Lines picked out, as a link to them names. */
  lines?: CodeLines
  onLinesChange?: (lines: CodeLines | undefined) => void
  /** An address for a file, or lines of it, to copy. */
  linkTo?: (path: string, lines?: CodeLines) => string
  /** What version of the code this is, at the end of the status line: "As last kept". */
  note?: string
  /** Where it can be edited. */
  editing?: CodeBrowserEditing
  /**
   * Where it is: filling a side pane's surface, edge to edge, or on a page as a card of its own,
   * as tall as `className` makes it.
   */
  frame?: 'pane' | 'card'
  className?: string
}

const COUNT = new Intl.NumberFormat('en')
const plural = (count: number, one: string, many = `${one}s`) => `${COUNT.format(count)} ${count === 1 ? one : many}`

// How long Copy says how it went.
const SHOWN_FOR = 1500

const split = (path: string) => {
  const at = path.lastIndexOf('/')
  return { folder: at === -1 ? '' : path.slice(0, at), name: path.slice(at + 1) }
}

// Something to say in place of the code, centred in it.
const Notice = ({ children, role }: { children: ReactNode; role?: 'status' | 'alert' }) => (
  <div role={role} className="grid h-full place-items-center p-8 text-center text-base/6 text-kumo-subtle">{children}</div>
)

// A pair of choices, as the app's tabs are: plain text, the chosen one on a pill.
const Segmented = <Value extends string>({ value, options, onChange, label }: {
  value: Value
  options: { value: Value; label: string }[]
  onChange: (value: Value) => void
  label: string
}) => (
  <div role="radiogroup" aria-label={label} className="flex shrink-0 items-center rounded-full bg-kumo-fill p-0.5">
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        role="radio"
        aria-checked={option.value === value}
        onClick={() => onChange(option.value)}
        className={cn(
          'h-8 cursor-pointer rounded-full px-3.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
          option.value === value ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-subtle hover:text-kumo-default',
        )}
      >
        {option.label}
      </button>
    ))}
  </div>
)

// What went wrong with edits, under the status line, with what can be done about it.
const Problem = ({ message, children }: { message: string; children?: ReactNode }) => (
  <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-kumo-line px-4 py-2.5 text-sm text-kumo-default">
    <WarningCircleIcon aria-hidden="true" className="size-4 shrink-0 text-kumo-danger" />
    <span className="min-w-0 flex-1">{message}</span>
    {children && <span className="flex shrink-0 gap-2">{children}</span>}
  </div>
)

const Kbd = ({ children }: { children: ReactNode }) => (
  <kbd className="rounded-[5px] bg-kumo-base px-1.5 font-sans text-xs leading-5 text-kumo-subtle ring-1 ring-kumo-line">{children}</kbd>
)

const mac = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform)
const MOD = mac ? '⌘' : 'Ctrl '

// The end of the status line where the code is edited live: why it can't be edited now, or what
// version of the code it is, after edits on their way, should they take a moment.
const LiveStatus = ({ editing, note }: { editing: CodeBrowserLive & { blocked?: string }; note?: string }) => {
  if (editing.blocked) return <span className="truncate" title={editing.blocked}>{editing.blocked}</span>
  return (
    <span className="flex min-w-0 items-center gap-3">
      {editing.sending && <span role="status" className="appears-late shrink-0">Sending…</span>}
      {note && <span className="truncate">{note}</span>}
    </span>
  )
}

// The end of the status line where the code can be edited as a draft: the draft, and Discard and
// Save; how a save is going; or why it can't be edited now; else what version of the code it is.
const DraftStatus = ({ editing, note }: { editing: CodeBrowserDraft & { blocked?: string }; note?: string }) => {
  const { changes, save, blocked } = editing
  if (save?.status === 'saving') return <span role="status" className="truncate">Saving…</span>
  if (changes > 0) {
    return (
      <span className="flex min-w-0 items-center gap-2 py-0.5">
        {blocked && <span className="min-w-0 truncate" title={blocked}>{blocked}</span>}
        <span className="shrink-0">{plural(changes, 'unsaved change')}</span>
        <ConfirmMenu
          label="Discard"
          title={`Discard your changes to ${plural(changes, 'file')}?`}
          description="Every file goes back to how it was."
          confirmLabel="Discard"
          onConfirm={editing.onDiscard}
          triggerVariant="ghost"
          triggerClassName="h-8 px-3 text-sm text-kumo-subtle"
        />
        <Button variant="primary" title={blocked ?? `Save (${MOD}S)`} disabled={!!blocked} onClick={editing.onSave} className="h-8 px-4 text-sm">Save</Button>
      </span>
    )
  }
  if (save?.status === 'saved') return <span role="status" className="truncate">Saved</span>
  if (blocked) return <span className="truncate" title={blocked}>{blocked}</span>
  return note ? <span className="truncate">{note}</span> : null
}

/**
 * A gadget's code, to read: its files down the side as a tree, and the one shown beside them in an
 * editor engineers would know (`CodeEditor`): line numbers that pick lines out for a link, folding,
 * find, go to line, and a status line with where the caret is, how the file is indented, what it
 * is written in and how long it is. Cmd or Ctrl with P goes to a file by a little of its name.
 *
 * Its history goes back through each time the code was kept; choosing one lists only what changed
 * then, each file as the change to it, in one column or, where there is room, two. Markdown is
 * shown as it reads, with its source a click away. Where it is narrow, as beside a chat, the files
 * are not a tree but a row of pills along the top of the code (`CodeFileStrip`).
 *
 * Where it can be edited (`editing`), the code is typed in and its files changed from the tree. As
 * a draft, the status line ends with how many files it changes, Discard (which asks first) and
 * Save, or else why it can't be edited now, and what came of a save is said under it. Live, each
 * edit goes as it is made, and only what went wrong is said under it.
 *
 * Files that changed from what they are compared with (`change`, where no past version is) are
 * listed apart over the tree, and each opens as its change (`before`), typed in there too.
 */
export const CodeBrowser = ({
  files, shown, onShow, file, before, onRetry, empty, history, lines, onLinesChange, linkTo, note, editing: editingProp, frame = 'pane', className,
}: CodeBrowserProps) => {
  const list = files.status === 'ready' ? files.files : []
  const { folder, name } = split(shown ?? '')
  const shownFile = list.find((each) => each.path === shown)
  const language = shown ? codeLanguage(shown) : undefined
  const reduceMotion = useReducedMotion() ?? false

  const [prefs, setPrefs] = useState<CodePrefs>(codePrefs.read)
  const changePrefs = (next: Partial<CodePrefs>) => setPrefs((was) => {
    const made = { ...was, ...next }
    codePrefs.write(made)
    return made
  })
  const [finding, setFinding] = useState(false)
  const [status, setStatus] = useState<CodeEditorStatus>()
  const [copied, setCopied] = useState<'copied' | 'failed'>()
  const [source, setSource] = useState(false)
  // A file that changed is shown as its change, typed in or not, in one column, until it is asked
  // for whole or in two, for as long as it is shown.
  const [view, setView] = useState<{ path: string; whole: boolean; columns: 1 | 2 }>()
  const viewed = view?.path === shown ? view : undefined
  const whole = viewed?.whole ?? false
  const columns = viewed?.columns ?? 1
  const setWhole = (next: boolean) => shown !== undefined && setView({ path: shown, whole: next, columns })
  const setColumns = (next: 1 | 2) => shown !== undefined && setView({ path: shown, whole, columns: next })
  const editor = useRef<CodeEditorHandle>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(undefined), SHOWN_FOR)
    return () => clearTimeout(timer)
  }, [copied])
  // Each file starts as it reads; its source is a click away.
  useEffect(() => {
    setSource(false)
  }, [shown])

  const comparing = history?.comparing
  const commits = history?.commits.status === 'ready' ? history.commits.commits : []
  const compared = comparing ? commits.find(({ id }) => id === comparing) : undefined
  const asDiff = (comparing !== undefined || !whole) && shownFile?.change !== undefined && before?.status === 'text' && file.status === 'text'
  // What changed, apart from the rest, where it is not a past version that is compared.
  const changed = comparing === undefined ? list.filter(({ change }) => change !== undefined) : []
  const markdown = language === 'markdown' && !asDiff && file.status === 'text'
  const showMarkdown = markdown && !source
  // A past version, compared, is only read.
  const editing = comparing === undefined ? editingProp : undefined
  const draft = editing?.kind === 'draft' ? editing : undefined
  const live = editing?.kind === 'live' ? editing : undefined
  const saving = draft?.save?.status === 'saving'
  const typeable = editing !== undefined && !editing.blocked && !saving && shownFile?.edit !== 'deleted' && shownFile?.change !== 'removed' && file.status === 'text'
  // A new file is named in the folder of the one shown.
  const [adding, setAdding] = useState<string>()
  const edits = editing ? new Map(list.flatMap(({ path, edit }) => (edit ? [[path, edit] as const] : []))) : undefined

  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => setCopied('copied'), () => setCopied('failed'))
  const download = () => {
    if (file.status !== 'text' || !name) return
    const url = URL.createObjectURL(new Blob([file.text], { type: 'text/plain' }))
    const link = Object.assign(document.createElement('a'), { href: url, download: name })
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Cmd or Ctrl with P anywhere in it goes to a file, and Alt with Z wraps its lines, as in the
  // editors engineers know: heard here, so that they work from the tree as well as the code.
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'p') {
      event.preventDefault()
      setFinding(true)
    } else if (event.altKey && event.code === 'KeyZ') {
      event.preventDefault()
      changePrefs({ wrap: !prefs.wrap })
    }
  }

  if (files.status === 'failed') {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-3 p-8 text-center', frame === 'card' && 'rounded-3xl bg-kumo-tint', className)}>
        <WarningCircleIcon aria-hidden="true" className="size-5 text-kumo-subtle" />
        <p className="text-base/6 text-kumo-subtle">Couldn’t read its code: {files.message}</p>
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
      </div>
    )
  }
  if (files.status === 'ready' && list.length === 0 && !comparing) {
    return <p className={cn('px-5 py-4 text-base/6 text-kumo-subtle', frame === 'card' && 'rounded-3xl bg-kumo-tint', className)}>{empty ?? 'There’s no code here yet.'}</p>
  }

  const tree = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={() => setFinding(true)}
          className="flex h-(--control-size) min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-xl bg-kumo-base ps-3.5 pe-2 text-left text-(length:--control-text) text-kumo-subtle ring-1 ring-kumo-line outline-none hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring"
        >
          <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Go to file</span>
          <span aria-hidden="true" className="flex gap-0.5"><Kbd>{MOD.trim()}</Kbd><Kbd>P</Kbd></span>
        </button>
        {editing && (
          <CodeIconButton
            icon={PlusIcon}
            aria-label="New file"
            title={editing.blocked ?? 'New file'}
            disabled={!!editing.blocked || saving}
            onClick={() => setAdding(folder)}
          />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-4">
        {changed.length > 0 && (
          <>
            <h4 className="px-3 pt-1 pb-1.5 text-sm font-medium text-kumo-subtle">Changes ({COUNT.format(changed.length)})</h4>
            <CodeChangeList files={changed} shown={shown} onShow={onShow} />
            <h4 className="px-3 pt-4 pb-1.5 text-sm font-medium text-kumo-subtle">Files</h4>
          </>
        )}
        {files.status === 'loading'
          ? <p role="status" className="appears-late px-3 py-2 text-sm text-kumo-subtle">Reading its files…</p>
          : list.length === 0
            ? <p className="px-3 py-2 text-sm text-kumo-subtle">Nothing changed in its files.</p>
            : (
              <CodeFileTree
                files={list}
                shown={shown}
                onShow={onShow}
                editing={editing && { ...editing, blocked: editing.blocked ?? (saving ? 'Saving…' : undefined) }}
                adding={adding}
                onAddingEnd={() => setAdding(undefined)}
              />
            )}
      </div>
    </div>
  )

  // A draft's state and its buttons take the room of what is said of the file but where the caret is.
  const drafting = draft !== undefined && (draft.changes > 0 || draft.save !== undefined)
  const statusLine = status && file.status === 'text' && !showMarkdown && (
    <>
      <span className="shrink-0 whitespace-nowrap tabular-nums">
        {status.selected
          ? `${plural(status.selected.characters, 'character')} selected${status.selected.lines > 1 ? ` on ${plural(status.selected.lines, 'line')}` : ''}`
          : `Ln ${COUNT.format(status.line)}, Col ${COUNT.format(status.column)}`}
      </span>
      <span className={cn('hidden whitespace-nowrap', !drafting && '@lg:inline')}>{status.indent}</span>
    </>
  )

  return (
    <div
      ref={root}
      onKeyDown={keyDown}
      className={cn(
        '@container relative flex min-h-0 flex-col',
        frame === 'card' ? 'overflow-hidden rounded-3xl bg-kumo-tint ring-1 ring-kumo-line' : 'h-full',
        className,
      )}
    >
      {/* What is being compared, over all of it, with the way back to the code as it is. */}
      <AnimatePresence initial={false}>
        {compared && history && (
          <motion.div
            key="comparing"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="flex items-center gap-2 px-3 pt-3 pb-1">
              <Button variant="ghost" icon={ArrowLeftIcon} aria-label="Back to the code as it is" title="Back to the code as it is" onClick={() => history.onCompare(undefined)} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-base font-medium text-kumo-default">{compared.summary}</span>
                <span className="truncate text-sm text-kumo-subtle">
                  {[compared.author, compared.time, files.status === 'ready' && plural(list.length, 'file') + ' changed'].filter(Boolean).join(' · ')}
                </span>
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex min-h-0 flex-1 flex-col @4xl:flex-row">
        {/* Where there is no room for the tree beside the code, the files along its top. */}
        <nav aria-label="Files" className="shrink-0 @4xl:hidden">
          <CodeFileStrip
            files={list}
            message={files.status === 'loading' ? 'Reading its files…' : list.length === 0 ? 'Nothing changed in its files.' : undefined}
            shown={shown}
            onShow={onShow}
            onFind={() => setFinding(true)}
            editing={editing && { ...editing, blocked: editing.blocked ?? (saving ? 'Saving…' : undefined) }}
            adding={adding}
            onAdd={() => setAdding(folder)}
            onAddingEnd={() => setAdding(undefined)}
          />
        </nav>
        {prefs.files && <nav aria-label="Files" className="hidden w-64 shrink-0 flex-col @4xl:flex">{tree}</nav>}

        <section
          aria-label={shown ?? 'File'}
          // Not a card of its own on the surface it is on: a line sets it off from the files, under
          // them where they are the tabs along its top and beside it where they are the tree.
          className={cn(
            'relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-t border-kumo-contrast/12 bg-kumo-base @4xl:border-t-0',
            prefs.files && '@4xl:border-s @4xl:border-kumo-contrast/12',
          )}
        >
          <header className="flex h-14 shrink-0 items-center gap-1 border-b border-kumo-line ps-2 pe-2">
            {/* Where the tree is beside the code, the way to put it away. */}
            <span className="hidden @4xl:inline">
              <Button
                variant="ghost"
                icon={SidebarSimpleIcon}
                aria-label={prefs.files ? 'Hide the files' : 'Show the files'}
                title={prefs.files ? 'Hide the files' : 'Show the files'}
                aria-pressed={prefs.files}
                onClick={() => changePrefs({ files: !prefs.files })}
                className="text-kumo-subtle"
              />
            </span>
            <h3 className="flex min-w-0 flex-1 items-center gap-2 ps-1 text-(length:--control-text) leading-5">
              {shown ? (
                <button
                  type="button"
                  onClick={() => setFinding(true)}
                  title={`${shown} · Go to file (${MOD}P)`}
                  className="min-w-0 cursor-pointer truncate rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                >
                  {folder && <span className="text-kumo-subtle">{folder.split('/').join(' / ')} / </span>}
                  <span className={cn('font-medium text-kumo-default', (shownFile?.change === 'removed' || shownFile?.edit === 'deleted') && 'line-through decoration-kumo-subtle/60')}>{name}</span>
                </button>
              ) : <span className="text-kumo-subtle">{files.status === 'loading' ? '' : 'No file'}</span>}
              {editing && shownFile?.edit && <span className="hidden shrink-0 text-sm text-kumo-subtle @md:inline">{editLabel(shownFile.edit)}</span>}
              {shownFile?.change && (
                <span className="flex shrink-0 items-center gap-1.5 text-sm">
                  <span className="hidden text-kumo-subtle @md:inline">{changeLabel(shownFile.change)}</span>
                  {asDiff && status?.diff && (
                    <span className="font-mono tabular-nums">
                      {status.diff.added > 0 && <span className="text-(--color-code-added-mark)">+{COUNT.format(status.diff.added)}</span>}
                      {status.diff.added > 0 && status.diff.removed > 0 && ' '}
                      {status.diff.removed > 0 && <span className="text-(--color-code-removed-mark)">−{COUNT.format(status.diff.removed)}</span>}
                    </span>
                  )}
                </span>
              )}
            </h3>
            {markdown && (
              <Segmented label="Show it" value={source ? 'code' : 'preview'} options={[{ value: 'preview', label: 'Preview' }, { value: 'code', label: 'Code' }]} onChange={(value) => setSource(value === 'code')} />
            )}
            {asDiff && (
              <span className="hidden @3xl:flex">
                <Segmented label="Show the change" value={columns === 2 ? 'split' : 'unified'} options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} onChange={(value) => setColumns(value === 'split' ? 2 : 1)} />
              </span>
            )}
            {history && (
              <DropdownMenu
                icon={ClockCounterClockwiseIcon}
                aria-label="History"
                triggerVariant="ghost"
                triggerClassName="text-kumo-subtle"
                align="end"
              >
                <DropdownMenu.Item icon={comparing === undefined ? CheckIcon : undefined} label="As it is" onSelect={() => history.onCompare(undefined)}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">As it is</span>
                    {note && <span className="block truncate text-sm text-kumo-subtle">{note}</span>}
                  </span>
                </DropdownMenu.Item>
                <DropdownMenu.Separator />
                {history.commits.status === 'loading' && <p role="status" className="px-3 py-2 text-sm text-kumo-subtle">Reading its history…</p>}
                {history.commits.status === 'failed' && <p className="px-3 py-2 text-sm text-kumo-subtle">Couldn’t read its history.</p>}
                {commits.map((commit) => (
                  <DropdownMenu.Item key={commit.id} icon={commit.id === comparing ? CheckIcon : undefined} label={commit.summary} onSelect={() => history.onCompare(commit.id)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{commit.summary}</span>
                      <span className="block truncate text-sm text-kumo-subtle">{[commit.author, commit.time].filter(Boolean).join(' · ')}</span>
                    </span>
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu>
            )}
            {file.status === 'text' && (
              <Button
                variant="ghost"
                icon={copied === 'copied' ? CheckIcon : copied === 'failed' ? XIcon : CopyIcon}
                aria-label={copied === 'copied' ? 'Copied' : copied === 'failed' ? 'Couldn’t copy' : `Copy ${name}`}
                title={copied === 'copied' ? 'Copied' : `Copy ${name}`}
                onClick={() => copy(file.text)}
                className="text-kumo-subtle"
              />
            )}
            <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${name || 'the code'}`} triggerVariant="ghost" triggerClassName="text-kumo-subtle" align="end">
              <DropdownMenu.Item icon={TextAlignLeftIcon} onSelect={() => changePrefs({ wrap: !prefs.wrap })}>
                <span className="min-w-0 flex-1">Wrap lines</span>
                {prefs.wrap ? <CheckIcon aria-label="On" weight="bold" className="size-4" /> : <span className="text-sm text-kumo-subtle">⌥Z</span>}
              </DropdownMenu.Item>
              <DropdownMenu.Item icon={MagnifyingGlassIcon} disabled={file.status !== 'text' || showMarkdown} onSelect={() => editor.current?.openFind()}>
                <span className="min-w-0 flex-1">Find in file</span>
                <span className="text-sm text-kumo-subtle">{MOD}F</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item icon={ListNumbersIcon} disabled={file.status !== 'text' || showMarkdown} onSelect={() => editor.current?.openGoToLine()}>
                <span className="min-w-0 flex-1">Go to line</span>
                <span className="text-sm text-kumo-subtle">⌃G</span>
              </DropdownMenu.Item>
              {comparing === undefined && shownFile?.change !== undefined && shownFile.change !== 'removed' && (
                <DropdownMenu.Item icon={GitDiffIcon} onSelect={() => setWhole(!whole)}>
                  <span className="min-w-0 flex-1">Show the change</span>
                  {!whole && <CheckIcon aria-label="On" weight="bold" className="size-4" />}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator />
              {shown && <DropdownMenu.Item icon={CopyIcon} onSelect={() => copy(shown)}>Copy path</DropdownMenu.Item>}
              {shown && linkTo && (
                <DropdownMenu.Item icon={LinkSimpleIcon} onSelect={() => copy(linkTo(shown, lines))}>
                  {lines ? (lines.from === lines.to ? `Copy link to line ${lines.from}` : `Copy link to lines ${lines.from}–${lines.to}`) : 'Copy link to file'}
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item icon={DownloadSimpleIcon} disabled={file.status !== 'text'} onSelect={download}>Download</DropdownMenu.Item>
            </DropdownMenu>
          </header>

          <div className="relative min-h-0 flex-1">
            {file.status === 'text' && (asDiff || !comparing || before === undefined) ? (
              showMarkdown ? (
                <div key={shown} className="appears h-full overflow-y-auto">
                  <div className="mx-auto max-w-3xl px-8 py-7 text-base text-kumo-default">
                    <Markdown>{file.text}</Markdown>
                  </div>
                </div>
              ) : (
                <Suspense fallback={<Notice role="status"><span className="appears-late">Opening {name}…</span></Notice>}>
                  <CodeEditor
                    key={shown}
                    ref={editor}
                    text={file.text}
                    language={language}
                    label={shown ?? 'Code'}
                    diff={asDiff && before?.status === 'text' ? { original: before.text, layout: columns === 2 ? 'split' : 'unified' } : undefined}
                    wrap={prefs.wrap}
                    picked={lines}
                    onPick={onLinesChange}
                    onStatus={setStatus}
                    memoryKey={shown && `${comparing ?? ''}:${shown}`}
                    editable={typeable}
                    onChange={editing && shown ? (text, change) => editing.onEdit(shown, text, change) : undefined}
                    onSave={draft && draft.changes > 0 && !saving ? draft.onSave : undefined}
                    historyKey={editing?.historyKey && shown && `${editing.historyKey}:${shown}`}
                    className="appears"
                  />
                </Suspense>
              )
            ) : file.status === 'other' ? (
              <Notice>{file.message}</Notice>
            ) : file.status === 'failed' ? (
              <Notice role="alert">
                <span className="flex flex-col items-center gap-3">
                  Couldn’t read {name || 'it'}: {file.message}
                  {onRetry && <Button onClick={onRetry}>Try again</Button>}
                </span>
              </Notice>
            ) : files.status === 'ready' && list.length === 0 ? (
              <Notice>Nothing changed in its files then.</Notice>
            ) : (
              <Notice role="status"><span className="appears-late">Reading {name || 'it'}…</span></Notice>
            )}
          </div>

          <footer className="flex min-h-10 shrink-0 items-center gap-3 border-t border-kumo-line px-4 text-sm text-kumo-subtle">
            {statusLine}
            <span className="ms-auto flex min-w-0 items-center gap-3">
              {file.status === 'text' && language && <span className={cn('hidden shrink-0', !drafting && '@md:inline')}>{CODE_LANGUAGE_NAMES[language]}</span>}
              {file.status === 'text' && status && !showMarkdown && <span className={cn('hidden shrink-0 tabular-nums', !drafting && '@sm:inline')}>{plural(status.lines, 'line')}</span>}
              {draft ? <DraftStatus editing={draft} note={note} /> : live ? <LiveStatus editing={live} note={note} /> : note && !comparing && <span className="truncate">{note}</span>}
            </span>
          </footer>
          {draft?.save && (draft.save.status === 'failed' || draft.save.status === 'conflict') && (
            <Problem message={draft.save.status === 'failed' ? `Couldn’t save: ${draft.save.message}` : draft.save.message}>
              {draft.save.status === 'conflict' && (
                <>
                  <Button onClick={draft.save.onDiscardMine} className="h-8 px-4 text-sm">Discard mine</Button>
                  <Button variant="primary" onClick={draft.save.onSaveAnyway} className="h-8 px-4 text-sm">Save mine anyway</Button>
                </>
              )}
            </Problem>
          )}
          {live?.lost && (
            <Problem message={live.lost}>
              <Button onClick={live.onDismissLost} className="h-8 px-4 text-sm">OK</Button>
            </Problem>
          )}
          {editing && <p role="status" className="sr-only">{editing.said}</p>}

          {finding && (
            <CodeQuickOpen
              paths={list.map(({ path }) => path)}
              shown={shown}
              edits={edits}
              lines={status?.lines}
              onOpen={(path) => {
                onShow(path)
                setFinding(false)
              }}
              onGoToLine={file.status === 'text' && !showMarkdown ? (line) => {
                setFinding(false)
                editor.current?.goToLine(line)
              } : undefined}
              onClose={() => setFinding(false)}
            />
          )}
        </section>
      </div>
    </div>
  )
}
