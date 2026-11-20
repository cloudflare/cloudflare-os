import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useMotionTransition, useReducedMotion } from '@gadgets/ui'
import { codeFileIcon } from './codeFileIcon'
import { EditDot, type CodeTreeEntry } from './CodeFileTree'
import { matchPaths } from './codeTree'

export type CodeQuickOpenProps = {
  /** The paths there are to go to. */
  paths: readonly string[]
  /** The one shown, which is left to the end of what is offered: it is already open. */
  shown?: string
  /** What unsaved edits did to each path they changed, which is marked. */
  edits?: ReadonlyMap<string, NonNullable<CodeTreeEntry['edit']>>
  /** How many lines the one shown has, for going to a line in it with a colon. */
  lines?: number
  onOpen: (path: string) => void
  /** Goes to a line of the one shown, from ":12". */
  onGoToLine?: (line: number) => void
  onClose: () => void
}

// The characters of a path that fit what was typed, in the text's colour; the rest stepped back.
const Marked = ({ text, indices, offset }: { text: string; indices: ReadonlySet<number>; offset: number }) => (
  <>
    {[...text].map((character, index) => indices.has(index + offset)
      ? <span key={index} className="font-semibold text-kumo-default">{character}</span>
      : character)}
  </>
)

/**
 * Go to a file by typing a little of its name (Cmd or Ctrl with P), as the editors engineers know
 * have it: what fits best first, the letters that fit marked, the arrow keys to move and Enter to
 * open. A colon and a number goes to that line of the file shown instead. Over the code, within it:
 * it is part of the code, not the page.
 */
const PANEL_SPRING = { type: 'spring', duration: 0.25, bounce: 0.1 } as const

export const CodeQuickOpen = ({ paths, shown, edits, lines, onOpen, onGoToLine, onClose }: CodeQuickOpenProps) => {
  const [typed, setTyped] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()
  const list = useRef<HTMLDivElement>(null)
  const reduceMotion = useReducedMotion()
  const transition = useMotionTransition(PANEL_SPRING)
  const line = /^:(\d+)$/.exec(typed.trim())?.[1]
  const found = useMemo(() => {
    if (line) return []
    const files = paths.map((path) => ({ path }))
    const matched = matchPaths(typed, files)
    // With nothing typed, the one open goes last: there is nowhere to go in it.
    return typed.trim() === '' ? [...matched.filter(({ file }) => file.path !== shown), ...matched.filter(({ file }) => file.path === shown)] : matched
  }, [paths, typed, shown, line])
  const at = Math.min(active, Math.max(found.length - 1, 0))

  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const choose = (index: number) => {
    const chosen = found[index]
    if (chosen) onOpen(chosen.file.path)
  }
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault()
      setActive((index) => Math.min(index + 1, found.length - 1))
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault()
      setActive((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      if (line && onGoToLine) onGoToLine(Math.min(Math.max(Number(line), 1), lines ?? Number(line)))
      else choose(at)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex justify-center px-3 pt-[min(12%,4rem)]">
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 bg-kumo-canvas/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: reduceMotion ? 0 : 0.15 }}
        onMouseDown={onClose}
      />
      <motion.div
        role="dialog"
        aria-label="Go to file"
        className="relative flex max-h-[min(26rem,80%)] w-[min(34rem,100%)] flex-col self-start overflow-hidden rounded-3xl bg-kumo-base text-kumo-default shadow-xl ring-1 ring-kumo-contrast/6"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.97, y: -6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={transition}
      >
        <div className="flex items-center gap-3 border-b border-kumo-line px-5">
          <MagnifyingGlassIcon aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={found[at] ? `${listId}-${at}` : undefined}
            aria-label="Go to file"
            placeholder="Go to file, or :line"
            spellCheck={false}
            autoComplete="off"
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              setActive(0)
            }}
            onKeyDown={keyDown}
            className="h-13 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-kumo-subtle"
          />
        </div>
        <div ref={list} id={listId} role="listbox" aria-label="Files" className="min-h-0 overflow-y-auto overscroll-contain p-2">
          {line ? (
            <p className="px-3 py-5 text-center text-(length:--control-text) text-kumo-subtle">
              {onGoToLine ? <>Go to line <span className="font-medium text-kumo-default tabular-nums">{line}</span>{lines ? ` of ${lines}` : ''}, with Enter</> : 'Open a file to go to a line in it'}
            </p>
          ) : found.length === 0 ? (
            <p className="px-3 py-5 text-center text-(length:--control-text) text-kumo-subtle">No file called “{typed.trim()}”</p>
          ) : found.map(({ file, indices }, index) => {
            const nameStart = file.path.lastIndexOf('/') + 1
            const folder = file.path.slice(0, Math.max(nameStart - 1, 0))
            const Icon = codeFileIcon(file.path)
            const marked = new Set(indices)
            return (
              <div
                key={file.path}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === at}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(index)}
                className="flex min-h-(--control-size) cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-(length:--control-text) aria-selected:bg-kumo-tint"
              >
                <Icon aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />
                <span className="min-w-0 truncate text-kumo-default">
                  <Marked text={file.path.slice(nameStart)} indices={marked} offset={nameStart} />
                </span>
                {folder && <span className="min-w-0 flex-1 truncate text-kumo-subtle"><Marked text={folder} indices={marked} offset={0} /></span>}
                {edits?.has(file.path) && <EditDot edit={edits.get(file.path)!} />}
                {file.path === shown && <span className="ms-auto shrink-0 text-sm text-kumo-subtle">Open</span>}
              </div>
            )
          })}
        </div>
        <div aria-hidden="true" className="flex items-center gap-4 border-t border-kumo-line px-5 py-2 text-sm text-kumo-subtle">
          <span><Key>↑</Key><Key>↓</Key> to move</span>
          <span><Key>↵</Key> to open</span>
          <span><Key>esc</Key> to close</span>
        </div>
      </motion.div>
    </div>
  )
}

const Key = ({ children }: { children: string }) => (
  <kbd className="me-1 inline-grid h-5 min-w-5 place-items-center rounded-[5px] bg-kumo-tint px-1 font-sans text-xs text-kumo-default ring-1 ring-kumo-line">{children}</kbd>
)
