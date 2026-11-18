import { useMemo, useState, type KeyboardEvent } from 'react'
import { CaretRightIcon, FolderSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { CodeFileMenu } from './CodeFileMenu'
import { CodeNameField } from './CodeNameField'
import { codeFileIcon } from './codeFileIcon'
import { buildCodeTree, foldersOf, type CodeTreeNode } from './codeTree'
import { useCodeNaming } from './useCodeNaming'

/** What can be done to a file from its menu, where the code can be edited, and what is said of it. */
export type CodeFileOffers = {
  rename: boolean
  duplicate: boolean
  /** True, or why it can't be. */
  delete: true | string
  /** It has unsaved changes, which can be put back. */
  restore: boolean
  /** Why renaming or deleting it asks first, as a sentence: "Counter stops working without this file." */
  caution?: string
}

/** One file of the code, as listed. */
export type CodeTreeEntry = {
  path: string
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

/** The letter that says how a file changed, as the editors engineers know use, in a colour for it. */
export const ChangeMark = ({ change }: { change: NonNullable<CodeTreeEntry['change']> }) => (
  <span className={cn('shrink-0 font-mono text-xs font-semibold', CHANGE[change].className)}>
    <span aria-hidden="true">{CHANGE[change].letter}</span>
    <span className="sr-only">{CHANGE[change].label}</span>
  </span>
)

// A row's room before it, by how deep it is: the width of a caret for each folder it is in.
const indent = (depth: number) => ({ paddingInlineStart: `${12 + depth * 16}px` })
// A file in a folder sits under the folder's name, past its caret.
const fileIndent = (depth: number) => indent(depth + (depth > 0 ? 1 : 0))

type Row =
  | { kind: 'node'; node: CodeTreeNode<CodeTreeEntry>; depth: number }
  | { kind: 'adding'; folder: string; depth: number }

/**
 * The files, as a tree of folders that open and close: the files at the root first, in the order
 * they are given, so that a gadget's screen and server side lead. Compared with how it was, each
 * file says how it changed,
 * by the letter the editors engineers know use; with unsaved edits, by a dot, a deleted file struck
 * through. The one shown is on a raised pill, and its folders are kept open. The arrow keys move
 * through what is shown, open and close folders, and go up to the folder a file is in; Enter and
 * Space open a file.
 *
 * Where its files can be changed (`editing`), each has a menu of what can be done to it, and a name
 * is typed in place, as it is in the tabs along the top (`useCodeNaming`): a new file's (`adding`) in
 * a row of its own at the end of its folder, raised, with the icon of what it will be and a hint
 * until something is typed, a file's new name in its own row.
 */
export const CodeFileTree = ({ files, shown, onShow, editing, adding, onAddingEnd }: CodeFileTreeProps) => {
  const tree = useMemo(() => buildCodeTree(files), [files])
  // Folders are open until closed: a gadget has few, and what is in them is the point.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string>()
  const naming = useCodeNaming({ editing, adding, onAddingEnd })
  const { renaming } = naming
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
    for (const node of nodes) {
      rows.push({ kind: 'node', node, depth })
      if (node.kind === 'folder' && isOpen(node.path)) walk(node.children, depth + 1, node.path)
    }
    // A new file is last in its folder, as a new tab is after the others.
    if (adding === folder) rows.push({ kind: 'adding', folder, depth })
  }
  walk(tree, 0, '')
  // A new folder, named nowhere yet: its row goes at the end.
  if (adding !== undefined && !rows.some((row) => row.kind === 'adding')) rows.push({ kind: 'adding', folder: adding, depth: 0 })
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
    void editing.onDuplicate(path).then((made) => made && naming.rename(made))
  }

  // A file's name typed in a row of its own, raised as a tab is, with the icon of what it will be.
  const nameRow = (key: string, depth: number, typed: string, initial: string, label: string, placeholder?: string) => {
    const Icon = codeFileIcon(typed || 'file.txt')
    return (
      <div key={key} role="none" className="flex flex-col gap-1">
        <div
          style={fileIndent(depth)}
          className="flex min-h-(--control-size) items-center gap-2.5 rounded-xl bg-kumo-base pe-2 text-(length:--control-text) text-kumo-default shadow-xs ring-1 ring-kumo-line"
        >
          <Icon aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />
          <CodeNameField fill {...naming.field(initial, label, placeholder)} />
        </div>
        {naming.problem && <p id={naming.problemId} role="alert" style={fileIndent(depth)} className="pe-2 text-sm text-kumo-danger">{naming.problem}</p>}
      </div>
    )
  }

  return (
    <div role="tree" aria-label="Files" onKeyDown={move} className="flex flex-col gap-0.5">
      {rows.map((row) => {
        if (row.kind === 'adding') return editing && nameRow('adding', row.depth, naming.typed, '', 'New file’s name', 'filename.ext')
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
              className="group flex h-(--control-size) shrink-0 cursor-pointer items-center gap-1.5 rounded-xl pe-3 text-left text-(length:--control-text) text-kumo-subtle outline-none hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring"
            >
              <CaretRightIcon aria-hidden="true" weight="bold" className={cn('size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} />
              <FolderSimpleIcon aria-hidden="true" weight={open ? 'regular' : 'fill'} className="size-[1.125em] shrink-0 opacity-80" />
              <span className="truncate">{node.name}</span>
            </button>
          )
        }
        const { file } = node
        if (editing && renaming === file.path) return nameRow(key, depth, naming.typed, node.name, `New name for ${node.name}`)
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
              'flex min-w-0 flex-1 shrink-0 cursor-pointer items-center gap-2.5 rounded-xl py-1.5 text-left text-(length:--control-text) outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
              'min-h-(--control-size)',
              offers ? 'pe-11' : 'pe-3',
              selected ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-default hover:bg-kumo-fill',
            )}
          >
            <Icon aria-hidden="true" className={cn('size-[1.125em] shrink-0', selected ? 'text-kumo-default' : 'text-kumo-subtle')} />
            <span className={cn('min-w-0 flex-1 truncate leading-5', deleted && 'text-kumo-subtle line-through decoration-kumo-subtle/60')}>{node.name}</span>
            {file.change && <ChangeMark change={file.change} />}
            {file.edit && <EditDot edit={file.edit} />}
          </button>
        )
        if (!offers || !editing) return item
        return (
          <div key={key} role="none" className="group relative flex">
            {item}
            <span className="absolute inset-y-0 end-1 flex items-center opacity-0 transition-opacity duration-75 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:opacity-100 pointer-coarse:opacity-100 motion-reduce:transition-none">
              <CodeFileMenu
                name={node.name}
                offers={offers}
                blocked={editing.blocked}
                onRename={() => naming.rename(file.path)}
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
