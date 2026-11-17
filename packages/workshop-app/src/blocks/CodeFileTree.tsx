import { useMemo, useState, type KeyboardEvent } from 'react'
import { CaretRightIcon, FolderSimpleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { codeFileIcon } from './codeFileIcon'
import { buildCodeTree, foldersOf, type CodeTreeNode } from './codeTree'

/** One file of the code, as listed. */
export type CodeTreeEntry = {
  path: string
  /** What it is to the gadget, in a few words: "What it shows". */
  role?: string
  /** How it changed, where the code is compared with how it was. */
  change?: 'added' | 'modified' | 'removed'
}

export type CodeFileTreeProps = {
  files: readonly CodeTreeEntry[]
  /** The path of the file shown. */
  shown?: string
  onShow: (path: string) => void
}

const CHANGE = {
  added: { letter: 'A', label: 'Added', className: 'text-(--color-code-added-mark)' },
  modified: { letter: 'M', label: 'Changed', className: 'text-kumo-brand' },
  removed: { letter: 'D', label: 'Taken away', className: 'text-(--color-code-removed-mark)' },
} as const

/** What a change is called, as a file's header and the tree say it. */
export const changeLabel = (change: NonNullable<CodeTreeEntry['change']>) => CHANGE[change].label

// A row's room before it, by how deep it is: the width of a caret for each folder it is in.
const indent = (depth: number) => ({ paddingInlineStart: `${10 + depth * 14}px` })

type Row = { node: CodeTreeNode<CodeTreeEntry>; depth: number }

/**
 * The files, as a tree of folders that open and close: the files at the root first, in the order
 * they are given, so that a gadget's screen and server side lead, each with what it is to the
 * gadget in a few words under its name. Compared with how it was, each file says how it changed,
 * by the letter the editors engineers know use. The one shown is on a raised pill, and its folders
 * are kept open. The arrow keys move through what is shown, open and close folders, and go up to
 * the folder a file is in; Enter and Space open a file.
 */
export const CodeFileTree = ({ files, shown, onShow }: CodeFileTreeProps) => {
  const tree = useMemo(() => buildCodeTree(files), [files])
  // Folders are open until closed: a gadget has few, and what is in them is the point.
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set())
  const [focused, setFocused] = useState<string>()
  const keptOpen = useMemo(() => new Set(shown ? foldersOf(shown) : []), [shown])
  const isOpen = (path: string) => keptOpen.has(path) || !closed.has(path)
  const toggle = (path: string) => setClosed((was) => {
    const next = new Set(was)
    if (isOpen(path)) next.add(path)
    else next.delete(path)
    return next
  })

  // What is shown, in order, for the arrow keys to move through.
  const rows: Row[] = []
  const walk = (nodes: CodeTreeNode<CodeTreeEntry>[], depth: number) => {
    for (const node of nodes) {
      rows.push({ node, depth })
      if (node.kind === 'folder' && isOpen(node.path)) walk(node.children, depth + 1)
    }
  }
  walk(tree, 0)
  const keyOf = (node: CodeTreeNode<CodeTreeEntry>) => (node.kind === 'folder' ? `folder:${node.path}` : node.file.path)
  const current = focused && rows.some(({ node }) => keyOf(node) === focused) ? focused : shown ?? (rows[0] && keyOf(rows[0].node))

  const move = (event: KeyboardEvent<HTMLElement>) => {
    const at = rows.findIndex(({ node }) => keyOf(node) === current)
    const row = rows[at]
    if (!row) return
    const focus = (index: number) => {
      const next = rows[Math.min(Math.max(index, 0), rows.length - 1)]
      if (!next) return
      const key = keyOf(next.node)
      setFocused(key)
      event.currentTarget.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus()
    }
    switch (event.key) {
      case 'ArrowDown': focus(at + 1); break
      case 'ArrowUp': focus(at - 1); break
      case 'Home': focus(0); break
      case 'End': focus(rows.length - 1); break
      case 'ArrowRight':
        if (row.node.kind === 'folder' && !isOpen(row.node.path)) toggle(row.node.path)
        else if (row.node.kind === 'folder') focus(at + 1)
        break
      case 'ArrowLeft': {
        if (row.node.kind === 'folder' && isOpen(row.node.path) && !keptOpen.has(row.node.path)) toggle(row.node.path)
        else {
          // Up to the folder it is in.
          const parent = rows.slice(0, at).findLastIndex(({ depth }) => depth < row.depth)
          if (parent !== -1) focus(parent)
        }
        break
      }
      default: return
    }
    event.preventDefault()
  }

  return (
    <div role="tree" aria-label="Files" onKeyDown={move} className="flex flex-col gap-px">
      {rows.map(({ node, depth }) => {
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
        const Icon = codeFileIcon(file.path)
        const selected = file.path === shown
        const change = file.change && CHANGE[file.change]
        return (
          <button
            key={key}
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={selected}
            aria-current={selected ? 'true' : undefined}
            data-key={key}
            tabIndex={tabIndex}
            title={change ? `${file.path} · ${change.label}` : file.path}
            onFocus={() => setFocused(key)}
            onClick={() => onShow(file.path)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onShow(file.path)
              }
            }}
            // A file in a folder sits under the folder's name, past its caret.
            style={indent(depth + (depth > 0 ? 1 : 0))}
            className={cn(
              'flex shrink-0 cursor-pointer items-center gap-2.5 rounded-xl py-1.5 pe-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
              file.role ? 'min-h-11' : 'min-h-8',
              selected ? 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line' : 'text-kumo-default hover:bg-kumo-fill',
            )}
          >
            <Icon aria-hidden="true" className={cn('size-4 shrink-0', selected ? 'text-kumo-default' : 'text-kumo-subtle')} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={cn('truncate text-sm/5', file.change === 'removed' && 'text-kumo-subtle line-through decoration-kumo-subtle/60')}>{node.name}</span>
              {file.role && <span className="truncate text-xs/4 text-kumo-subtle">{file.role}</span>}
            </span>
            {change && (
              <span className={cn('shrink-0 font-mono text-[11px] font-semibold', change.className)}>
                <span aria-hidden="true">{change.letter}</span>
                <span className="sr-only">{change.label}</span>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
