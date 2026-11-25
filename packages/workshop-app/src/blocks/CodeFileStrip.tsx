import { useEffect, useMemo, useRef } from 'react'
import { PlusSignIcon, Search01Icon } from '@/components/icons'
import { cn } from '@cloudflare/kumo/utils'
import { ChangeMark, changeLabel, EditDot, editLabel, type CodeFileEditing, type CodeTreeEntry } from './CodeFileTree'
import { CodeFileMenu } from './CodeFileMenu'
import { CodeIconButton } from './CodeIconButton'
import { codeFileIcon } from './codeFileIcon'
import { CodeNameField } from './CodeNameField'
import { buildCodeTree, nameOf, type CodeTreeNode } from './codeTree'
import { useCodeNaming } from './useCodeNaming'

export type CodeFileStripProps = {
  files: readonly CodeTreeEntry[]
  /** What it says in place of the files, while they are read or when there are none. */
  message?: string
  /** The path of the file shown. */
  shown?: string
  onShow: (path: string) => void
  /** Goes to a file by a little of its name. */
  onFind: () => void
  /** Where its files can be changed. */
  editing?: CodeFileEditing
  /** A new file is being named, in this folder ('' for the top), until `onAddingEnd`. */
  adding?: string
  onAdd: () => void
  onAddingEnd: () => void
}

// The files in the order the tree lists them, without its folders.
const flatten = (nodes: CodeTreeNode<CodeTreeEntry>[]): CodeTreeEntry[] =>
  nodes.flatMap((node) => (node.kind === 'folder' ? flatten(node.children) : [node.file]))

// The shell of a tab, raised where it is the one shown, or being named.
const TAB = 'flex h-(--control-size) items-center rounded-xl text-(length:--control-text)'
const RAISED = 'bg-kumo-base text-kumo-default shadow-xs ring-1 ring-kumo-line'

/**
 * The files along the top, where there is no room for the tree beside the code: one tab each, as an
 * editor has them, in the order the tree lists them, scrolled along, the one shown raised and
 * brought into view. Go to file is before them and, where its files can be changed, New file is
 * after them: right after the last where they do not fill the width, else at the end. Each says how
 * it changed, or what unsaved edits did to it, as the tree does; the one shown has the menu of what
 * can be done to it inside its tab.
 *
 * A new file is a tab at once, after the others, and its name is typed in it until Enter makes it,
 * as renaming a file types its new name in its own tab. What is wrong with a name is said under the
 * tabs as it is typed, Escape puts it away, and leaving it takes it where it can go.
 */
export const CodeFileStrip = ({ files, message, shown, onShow, onFind, editing, adding, onAdd, onAddingEnd }: CodeFileStripProps) => {
  const ordered = useMemo(() => flatten(buildCodeTree(files)), [files])
  // A name stands for its file unless another has it, which are told apart by their paths.
  const names = useMemo(() => {
    const counts = new Map<string, number>()
    for (const { path } of ordered) counts.set(nameOf(path), (counts.get(nameOf(path)) ?? 0) + 1)
    return counts
  }, [ordered])
  const list = useRef<HTMLUListElement>(null)
  const current = useRef<HTMLButtonElement>(null)
  const naming = useCodeNaming({ editing, adding, onAddingEnd })
  const { renaming, problem, problemId } = naming

  useEffect(() => {
    const row = list.current
    const tab = current.current
    if (row && tab) row.scrollTo?.({ left: tab.offsetLeft - (row.clientWidth - tab.offsetWidth) / 2 })
  }, [shown])
  // A new file's tab is the last, so it is scrolled to the very end of the tabs.
  const adds = adding !== undefined
  useEffect(() => {
    const row = list.current
    if (adds && row) row.scrollTo?.({ left: row.scrollWidth })
  }, [adds])

  const duplicate = (path: string) => {
    if (!editing) return
    void editing.onDuplicate(path).then((made) => made && naming.rename(made))
  }

  const NewIcon = codeFileIcon(naming.typed || 'file.txt')
  const hint = adding !== undefined && adding !== '' && !problem ? `New file in ${adding}` : undefined

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <CodeIconButton icon={Search01Icon} aria-label="Go to file" onClick={onFind} />
        {message ? (
          <p role="status" className="min-w-0 flex-1 truncate px-2 text-(length:--control-text) text-kumo-subtle">{message}</p>
        ) : (
          // As wide as its tabs, no wider, so that New file follows the last of them; once they
          // fill the room, they scroll and New file stays at the end. Scrolling clips what is past
          // its edges, so the raised tab's ring and shadow need room inside them.
          <ul ref={list} aria-label="Files" className="relative -my-0.5 flex min-w-0 items-center gap-1 overflow-x-auto px-0.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {ordered.map((file) => {
              const selected = file.path === shown
              const Icon = codeFileIcon(file.path)
              const deleted = file.change === 'removed' || file.edit === 'deleted'
              const detail = file.change ? changeLabel(file.change) : file.edit ? editLabel(file.edit) : undefined
              const offers = selected && editing ? file.offers : undefined
              // Its name is being typed in its own tab.
              if (editing && renaming === file.path) {
                return (
                  <li key={file.path} className="flex shrink-0">
                    <div className={cn(TAB, RAISED, 'gap-2 ps-3 pe-2')}>
                      <Icon aria-hidden="true" className="size-[1.125em] shrink-0" />
                      <CodeNameField {...naming.field(nameOf(file.path), `New name for ${nameOf(file.path)}`)} />
                    </div>
                  </li>
                )
              }
              return (
                <li key={file.path} className="flex shrink-0">
                  {/* The tab is the shell, so that the menu of the one shown is inside it. */}
                  <div className={cn(TAB, selected ? RAISED : 'text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default')}>
                    <button
                      ref={selected ? current : undefined}
                      type="button"
                      aria-current={selected ? 'true' : undefined}
                      title={detail ? `${file.path} · ${detail}` : file.path}
                      onClick={() => onShow(file.path)}
                      className={cn(
                        'flex h-(--control-size) shrink-0 cursor-pointer items-center gap-2 rounded-xl ps-3 text-(length:--control-text) outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring',
                        offers ? 'pe-1.5' : 'pe-3',
                      )}
                    >
                      <Icon aria-hidden="true" className="size-[1.125em] shrink-0" />
                      <span className={cn('whitespace-nowrap', deleted && 'line-through decoration-kumo-subtle/60')}>
                        {names.get(nameOf(file.path)) === 1 ? nameOf(file.path) : file.path}
                      </span>
                      {!offers && file.change && <ChangeMark change={file.change} />}
                      {!offers && file.edit && <EditDot edit={file.edit} />}
                    </button>
                    {offers && editing && (
                      <span className={cn('flex items-center gap-1', file.change || file.edit ? 'pe-3' : 'pe-0.5')}>
                        <CodeFileMenu
                          name={nameOf(file.path)}
                          offers={offers}
                          blocked={editing.blocked}
                          onRename={() => naming.rename(file.path)}
                          onDuplicate={() => duplicate(file.path)}
                          onDelete={() => editing.onDelete(file.path)}
                          onRestore={() => editing.onRestore(file.path)}
                          quiet
                        />
                        {/* How it changed is last in its tab, after its menu. */}
                        {file.change && <ChangeMark change={file.change} />}
                        {file.edit && <EditDot edit={file.edit} />}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
            {/* A new file is a tab as soon as New file is pressed, named where it stands. */}
            {editing && adding !== undefined && (
              <li className="flex shrink-0">
                <div className={cn(TAB, RAISED, 'gap-2 ps-3 pe-2')}>
                  <NewIcon aria-hidden="true" className="size-[1.125em] shrink-0" />
                  <CodeNameField {...naming.field('', 'New file’s name', 'filename.ext')} />
                </div>
              </li>
            )}
          </ul>
        )}
        {editing && (
          <CodeIconButton icon={PlusSignIcon} aria-label="New file" title={editing.blocked ?? 'New file'} disabled={!!editing.blocked || adding !== undefined} onClick={onAdd} />
        )}
      </div>
      {problem && <p id={problemId} role="alert" className="px-3 pb-1 text-sm text-kumo-danger">{problem}</p>}
      {hint && <p className="px-3 pb-1 text-sm text-kumo-subtle">{hint}</p>}
    </div>
  )
}
