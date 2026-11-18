import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowCounterClockwiseIcon, CaretRightIcon, CopyIcon, DotsThreeIcon, FolderSimpleIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { DropdownMenu } from '@/components/DropdownMenu'
import { TextField } from '@/components/TextField'
import { codeFileIcon } from './codeFileIcon'
import { buildCodeTree, foldersOf, type CodeTreeNode } from './codeTree'

/** What can be done to a file from its menu, where the code can be edited, and what is said of it. */
export type CodeFileOffers = {
  rename: boolean
  duplicate: boolean
  /** True, or why it can't be. */
  delete: true | string
  /** It has unsaved changes, which can be put back. */
  restore: boolean
  /** A word of caution for renaming or deleting it: "Counter starts from it". */
  caution?: string
}

/** One file of the code, as listed. */
export type CodeTreeEntry = {
  path: string
  /** What it is to the gadget, in a few words: "What it shows". */
  role?: string
  /** How it changed, where the code is compared with how it was. */
  change?: 'added' | 'modified' | 'removed'
  /** How unsaved edits change it. */
  edit?: 'added' | 'changed' | 'deleted'
  /** What can be done to it from its menu, where the code can be edited. */
  offers?: CodeFileOffers
}

/** What a name typed for a file comes to: where it goes, why it can't, or nothing typed (or nothing changed). */
export type CodeNameCheck = { path: string } | { problem: string } | { none: true }

/** The tree's files made, renamed, copied, deleted and put back, each named in place. */
export type CodeFileEditing = {
  /** Why files can't be changed now: their actions are out of use, saying so. */
  blocked?: string
  /** What a name typed for a new file in `folder` ('' for the top), or for renaming a file, comes to. */
  check: (name: string, at: { folder: string } | { renaming: string }) => CodeNameCheck
  onCreate: (path: string) => void
  onRename: (path: string, to: string) => void
  /** Makes a copy of it beside it, and says what it is, to be renamed. */
  onDuplicate: (path: string) => Promise<string | undefined>
  onDelete: (path: string) => void
  onRestore: (path: string) => void
}

export type CodeFileTreeProps = {
  files: readonly CodeTreeEntry[]
  /** The path of the file shown. */
  shown?: string
  onShow: (path: string) => void
  /** Where its files can be changed. */
  editing?: CodeFileEditing
  /** A new file is being named, in this folder ('' for the top), until `onAddingEnd`. */
  adding?: string
  onAddingEnd?: () => void
}

const CHANGE = {
  added: { letter: 'A', label: 'Added', className: 'text-(--color-code-added-mark)' },
  modified: { letter: 'M', label: 'Changed', className: 'text-kumo-brand' },
  removed: { letter: 'D', label: 'Taken away', className: 'text-(--color-code-removed-mark)' },
} as const

const EDIT = {
  added: { label: 'New, not saved', className: 'bg-(--color-code-added-mark)' },
  changed: { label: 'Changed, not saved', className: 'bg-kumo-brand' },
  deleted: { label: 'Deleted, not saved', className: 'bg-(--color-code-removed-mark)' },
} as const

/** What a change is called, as a file's header and the tree say it. */
export const changeLabel = (change: NonNullable<CodeTreeEntry['change']>) => CHANGE[change].label

/** What unsaved edits did to a file, as the tree and quick open say it. */
export const editLabel = (edit: NonNullable<CodeTreeEntry['edit']>) => EDIT[edit].label

/** The dot that marks a file with unsaved edits, by what they did to it. */
export const EditDot = ({ edit }: { edit: NonNullable<CodeTreeEntry['edit']> }) => (
  <span className="flex size-4 shrink-0 items-center justify-center">
    <span aria-hidden="true" className={cn('size-2 rounded-full', EDIT[edit].className)} />
    <span className="sr-only">{EDIT[edit].label}</span>
  </span>
)

// A row's room before it, by how deep it is: the width of a caret for each folder it is in.
const indent = (depth: number) => ({ paddingInlineStart: `${10 + depth * 14}px` })
// A file in a folder sits under the folder's name, past its caret.
const fileIndent = (depth: number) => indent(depth + (depth > 0 ? 1 : 0))

type Row =
  | { kind: 'node'; node: CodeTreeNode<CodeTreeEntry>; depth: number }
  | { kind: 'adding'; folder: string; depth: number }

/**
 * The files, as a tree of folders that open and close: the files at the root first, in the order
 * they are given, so that a gadget's screen and server side lead, each with what it is to the
 * gadget in a few words under its name. Compared with how it was, each file says how it changed,
 * by the letter the editors engineers know use; with unsaved edits, by a dot, a deleted file struck
 * through. The one shown is on a raised pill, and its folders are kept open. The arrow keys move
 * through what is shown, open and close folders, and go up to the folder a file is in; Enter and
 * Space open a file.
 *
 * Where its files can be changed (`editing`), each has a menu of what can be done to it, and a name
 * is typed in place: a new file's (`adding`) in a row of its own, a file's new name over its own.
 */
export const CodeFileTree = ({ files, shown, onShow, editing, adding, onAddingEnd }: CodeFileTreeProps) => {
  const tree = useMemo(() => buildCodeTree(files), [files])
  // Folders are open until closed: a gadget has few, and what is in them is the point.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string>()
  const [renaming, setRenaming] = useState<string>()
  const keptOpen = useMemo(() => new Set([...(shown ? foldersOf(shown) : []), ...(adding ? foldersOf(`${adding}/_`) : [])]), [shown, adding])
  const isOpen = (path: string) => keptOpen.has(path) || !closed.has(path)
  const toggle = (path: string) => setClosed((was) => {
    const next = new Set(was)
    if (isOpen(path)) next.add(path)
    else next.delete(path)
    return next
  })

  // What is shown, in order, for the arrow keys to move through, with where a new file is named.
  const rows: Row[] = []
  const walk = (nodes: CodeTreeNode<CodeTreeEntry>[], depth: number, folder: string) => {
    if (adding === folder) rows.push({ kind: 'adding', folder, depth })
    for (const node of nodes) {
      rows.push({ kind: 'node', node, depth })
      if (node.kind === 'folder' && isOpen(node.path)) walk(node.children, depth + 1, node.path)
    }
  }
  walk(tree, 0, '')
  // A new folder, named nowhere yet: its row goes at the top.
  if (adding !== undefined && !rows.some((row) => row.kind === 'adding')) rows.unshift({ kind: 'adding', folder: adding, depth: 0 })
  const nodes = rows.flatMap((row) => (row.kind === 'node' ? [row] : []))
  const keyOf = (node: CodeTreeNode<CodeTreeEntry>) => (node.kind === 'folder' ? `folder:${node.path}` : node.file.path)
  const current = focused && nodes.some(({ node }) => keyOf(node) === focused) ? focused : shown ?? (nodes[0] && keyOf(nodes[0].node))

  const move = (event: KeyboardEvent<HTMLElement>) => {
    const at = nodes.findIndex(({ node }) => keyOf(node) === current)
    const row = nodes[at]
    if (!row) return
    const focus = (index: number) => {
      const next = nodes[Math.min(Math.max(index, 0), nodes.length - 1)]
      if (!next) return
      const key = keyOf(next.node)
      setFocused(key)
      event.currentTarget.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus()
    }
    switch (event.key) {
      case 'ArrowDown': focus(at + 1); break
      case 'ArrowUp': focus(at - 1); break
      case 'Home': focus(0); break
      case 'End': focus(nodes.length - 1); break
      case 'ArrowRight':
        if (row.node.kind === 'folder' && !isOpen(row.node.path)) toggle(row.node.path)
        else if (row.node.kind === 'folder') focus(at + 1)
        break
      case 'ArrowLeft': {
        if (row.node.kind === 'folder' && isOpen(row.node.path) && !keptOpen.has(row.node.path)) toggle(row.node.path)
        else {
          // Up to the folder it is in.
          const parent = nodes.slice(0, at).findLastIndex(({ depth }) => depth < row.depth)
          if (parent !== -1) focus(parent)
        }
        break
      }
      default: return
    }
    event.preventDefault()
  }

  const duplicate = (path: string) => {
    if (!editing) return
    void editing.onDuplicate(path).then((made) => made && setRenaming(made))
  }

  return (
    <div role="tree" aria-label="Files" onKeyDown={move} className="flex flex-col gap-px">
      {rows.map((row) => {
        if (row.kind === 'adding') {
          return editing && (
            <NameRow
              key="adding"
              label="New file’s name"
              initial=""
              depth={row.depth + (row.depth > 0 ? 1 : 0)}
              check={(name) => editing.check(name, { folder: row.folder })}
              onDone={(path) => {
                onAddingEnd?.()
                if (path) editing.onCreate(path)
              }}
            />
          )
        }
        const { node, depth } = row
        const key = keyOf(node)
        const tabIndex = key === current ? 0 : -1
        if (node.kind === 'folder') {
          const open = isOpen(node.path)
          return (
            <button
              key={key}
              type="button"
              role="treeitem"
              aria-expanded={open}
              aria-level={depth + 1}
              data-key={key}
              tabIndex={tabIndex}
              onFocus={() => setFocused(key)}
              onClick={() => toggle(node.path)}
              style={indent(depth)}
              className="group flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl pe-3 text-left text-sm text-kumo-subtle outline-none hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <CaretRightIcon aria-hidden="true" weight="bold" className={cn('size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />
              <FolderSimpleIcon aria-hidden="true" weight={open ? 'regular' : 'fill'} className="size-4 shrink-0 opacity-80" />
              <span className="truncate">{node.name}</span>
            </button>
          )
        }
        const { file } = node
        if (editing && renaming === file.path) {
          return (
            <NameRow
              key={key}
              label={`New name for ${node.name}`}
              initial={node.name}
              depth={depth + (depth > 0 ? 1 : 0)}
              check={(name) => editing.check(name, { renaming: file.path })}
              onDone={(path) => {
                setRenaming(undefined)
                if (path) editing.onRename(file.path, path)
              }}
            />
          )
        }
        const Icon = codeFileIcon(file.path)
        const selected = file.path === shown
        const change = file.change && CHANGE[file.change]
        const offers = editing && file.offers
        const deleted = file.change === 'removed' || file.edit === 'deleted'
        const item = (
          <button
            key={key}
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected}
            aria-current={selected ? 'true' : undefined}
            data-key={key}
            tabIndex={tabIndex}
            title={change ? `${file.path} · ${change.label}` : file.edit ? `${file.path} · ${EDIT[file.edit].label}` : file.path}
            onFocus={() => setFocused(key)}
            onClick={() => onShow(file.path)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onShow(file.path)
              }
            }}
            style={fileIndent(depth)}
            className={cn(
              'flex min-w-0 flex-1 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
              file.role ? 'min-h-11' : 'min-h-8',
              offers ? 'pe-10' : 'pe-3',
              selected ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-default hover:bg-kumo-fill',
            )}
          >
            <Icon aria-hidden="true" className={cn('size-4 shrink-0', selected ? 'text-kumo-default' : 'text-kumo-subtle')} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate text-sm/5', deleted && 'text-kumo-subtle line-through decoration-kumo-subtle/60')}>{node.name}</span>
              {file.role && <span className="truncate text-xs/4 text-kumo-subtle">{file.role}</span>}
            </span>
            {change && (
              <span className={cn('shrink-0 font-mono text-[11px] font-semibold', change.className)}>
                <span aria-hidden="true">{change.letter}</span>
                <span className="sr-only">{change.label}</span>
              </span>
            )}
            {file.edit && <EditDot edit={file.edit} />}
          </button>
        )
        if (!offers || !editing) return item
        return (
          <div key={key} role="none" className="group relative flex">
            {item}
            <span className="absolute inset-y-0 end-1 flex items-center opacity-0 transition-opacity duration-75 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
              <FileMenu
                name={node.name}
                offers={offers}
                blocked={editing.blocked}
                onRename={() => setRenaming(file.path)}
                onDuplicate={() => duplicate(file.path)}
                onDelete={() => editing.onDelete(file.path)}
                onRestore={() => editing.onRestore(file.path)}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}

// An item's name over what is said of it, in a menu.
const Labelled = ({ label, detail }: { label: string; detail?: string }) => (
  <span className="min-w-0 flex-1">
    <span className="block truncate">{label}</span>
    {detail && <span className="block text-xs text-kumo-subtle">{detail}</span>}
  </span>
)

// What can be done to one file, out of use with why where it can't be now.
const FileMenu = ({ name, offers, blocked, onRename, onDuplicate, onDelete, onRestore }: {
  name: string
  offers: CodeFileOffers
  blocked?: string
  onRename: () => void
  onDuplicate: () => void
  onDelete: () => void
  onRestore: () => void
}) => (
  <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${name}`} triggerVariant="ghost" triggerClassName="size-7 text-kumo-subtle" align="end">
    {blocked && <DropdownMenu.Label>{blocked}</DropdownMenu.Label>}
    {offers.rename && (
      <DropdownMenu.Item icon={PencilSimpleIcon} label="Rename" disabled={!!blocked} onSelect={onRename}>
        <Labelled label="Rename" detail={offers.caution} />
      </DropdownMenu.Item>
    )}
    {offers.duplicate && (
      <DropdownMenu.Item icon={CopyIcon} label="Duplicate" disabled={!!blocked} onSelect={onDuplicate}>Duplicate</DropdownMenu.Item>
    )}
    {offers.restore && (
      <DropdownMenu.Item icon={ArrowCounterClockwiseIcon} label="Restore" disabled={!!blocked} onSelect={onRestore}>
        <Labelled label="Restore" detail="As it was before your changes" />
      </DropdownMenu.Item>
    )}
    {(offers.rename || offers.duplicate || offers.restore) && <DropdownMenu.Separator />}
    <DropdownMenu.Item icon={TrashIcon} label="Delete" danger disabled={!!blocked || offers.delete !== true} onSelect={onDelete}>
      <Labelled label="Delete" detail={offers.delete === true ? offers.caution : offers.delete} />
    </DropdownMenu.Item>
  </DropdownMenu>
)

// A file's name typed in place in the tree: what is wrong with it said under it as it is typed,
// Enter or leaving it taking it where it can go, and Escape (or leaving it as it was) putting it
// away. A name is selected without its extension, to type over.
const NameRow = ({ label, initial, depth, check, onDone }: {
  label: string
  initial: string
  depth: number
  check: (name: string) => CodeNameCheck
  /** The path it comes to, or nothing where it was put away. */
  onDone: (path: string | undefined) => void
}) => {
  const [value, setValue] = useState(initial)
  const problemId = useId()
  const field = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  const answer = check(value)
  const problem = 'problem' in answer ? answer.problem : undefined
  const finish = (path: string | undefined) => {
    if (done.current) return
    done.current = true
    onDone(path)
  }
  useEffect(() => {
    const input = field.current
    if (!input) return
    input.focus()
    const dot = initial.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : initial.length)
  }, [initial])
  return (
    <div role="none" style={indent(depth)} className="flex flex-col gap-1 py-1 pe-1">
      <TextField
        ref={field}
        aria-label={label}
        value={value}
        onValueChange={setValue}
        invalid={problem !== undefined}
        aria-describedby={problem ? problemId : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onKeyDown={(event) => {
          // The tree's keys are not for the field.
          event.stopPropagation()
          if (event.key === 'Escape') {
            event.preventDefault()
            finish(undefined)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            if ('path' in answer) finish(answer.path)
            else if ('none' in answer) finish(undefined)
          }
        }}
        onBlur={() => finish('path' in answer ? answer.path : undefined)}
        className="h-8 rounded-lg px-2 text-sm"
      />
      {problem && <p id={problemId} className="px-1 text-xs text-kumo-danger">{problem}</p>}
    </div>
  )
}
