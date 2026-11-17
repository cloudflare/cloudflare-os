import { useRef, type KeyboardEvent } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { ExactText } from '../../components/ExactText'
import { WorkshopButton } from '../../components/WorkshopControls'
import { formatSize } from '../../components/ActionFields'
import { ROOT_LABEL, commitSubject, pathChange, shortOid, type PathRow, type ReviewItem } from './pushReviewModel'

const CHANGE_WORDS = { added: 'Added', modified: 'Modified', deleted: 'Deleted', mode: 'Mode' } as const

const captionClass = 'text-[11.5px] leading-4 tracking-[-0.1px] text-kumo-inactive'
const placeholderClass = 'italic text-kumo-subtle'

const itemClass = (selected: boolean) =>
  `flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-[12.5px] leading-[18px] tracking-[-0.15px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring ${
    selected ? 'bg-kumo-tint text-kumo-default' : 'text-kumo-default hover:bg-kumo-elevated'
  }`

const CommitLabel = ({ item }: { item: Extract<ReviewItem, { kind: 'commit' }> }) => {
  const { oid, text, size } = item.reviewed.commit
  const subject = text === undefined ? undefined : commitSubject(text)
  return (
    <>
      <span className={`font-mono ${captionClass}`}>Commit {shortOid(oid)}</span>
      {text === undefined ? (
        <span className={placeholderClass}>{size === undefined ? 'Not in this workspace yet' : 'Cannot be read as text'}</span>
      ) : subject ? (
        <ExactText text={subject} singleLine className="font-medium" />
      ) : (
        <span className={placeholderClass}>{subject === undefined ? 'No message' : 'Empty first line'}</span>
      )}
    </>
  )
}

const PathLabel = ({ row, problem }: { row: PathRow, problem: string | undefined }) => (
  <>
    {row.path === ''
      ? <span className={placeholderClass}>{ROOT_LABEL}</span>
      : <ExactText text={row.path} singleLine className="font-mono text-[12px]" />}
    <span className={`flex items-center gap-1 ${captionClass}`}>
      {CHANGE_WORDS[pathChange(row)]}
      {row.entry && !row.sent && ' · not sent'}
      {problem && (
        <span className="flex items-center gap-0.5 text-kumo-danger">
          <WarningCircle size={12} weight="fill" aria-hidden />
          {problem}
        </span>
      )}
    </span>
  </>
)

/**
 * The left pane of the push review: every commit in order with the paths it lists beneath it,
 * then the objects the push sends at no path. One item is selected, and the list is one tab stop:
 * the arrow keys, Home and End move the selection and the focus together.
 */
export const PushReviewList = ({ items, selectedKey, onSelect, problemOf, more }: {
  items: readonly ReviewItem[]
  selectedKey: string | undefined
  onSelect: (item: ReviewItem) => void
  /** What went wrong reading a row's file, in a word or two, for the rows where something did. */
  problemOf: (row: PathRow) => string | undefined
  /** Present while pages remain that are read only when asked for; `shown` counts the entries read. */
  more?: { shown: number, loading: boolean, onLoadMore: () => void }
}) => {
  const listRef = useRef<HTMLUListElement>(null)
  const firstObject = items.findIndex(item => item.kind === 'object')

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    const current = items.findIndex(item => item.key === selectedKey)
    const target = event.key === 'ArrowDown' ? Math.min(current + 1, items.length - 1)
      : event.key === 'ArrowUp' ? Math.max(current - 1, 0)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? items.length - 1
            : undefined
    if (target === undefined) return
    event.preventDefault()
    onSelect(items[target])
    listRef.current?.querySelector<HTMLElement>(`[data-review-item="${target}"]`)?.focus()
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <ul
        ref={listRef}
        aria-label="Commits and files of this push"
        className="m-0 flex list-none flex-col gap-0.5 p-0"
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => {
          const selected = item.key === selectedKey
          return (
            <li key={item.key} className={item.kind === 'path' ? 'pl-3' : index > 0 ? 'mt-1.5' : ''}>
              {index === firstObject && (
                <p className="m-0 px-2 pb-1 pt-1.5 text-[11.5px] font-semibold leading-4 text-kumo-default">
                  Sent without a path
                </p>
              )}
              <button
                type="button"
                data-review-item={index}
                aria-current={selected ? 'true' : undefined}
                tabIndex={selected ? 0 : -1}
                className={itemClass(selected)}
                onClick={() => onSelect(item)}
              >
                {item.kind === 'commit' ? (
                  <CommitLabel item={item} />
                ) : item.kind === 'path' ? (
                  <PathLabel row={item.row} problem={problemOf(item.row)} />
                ) : (
                  <>
                    <span className="font-mono text-[12px]">{item.row.type} {shortOid(item.row.oid)}</span>
                    <span className={captionClass}>
                      {item.row.size === undefined ? 'Not in this workspace yet' : formatSize(item.row.size)}
                    </span>
                  </>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {more && (
        <div className="flex flex-col items-start gap-1.5 px-2 pb-1">
          <p className={`m-0 ${captionClass}`}>
            Showing the first {more.shown} {more.shown === 1 ? 'entry' : 'entries'}
          </p>
          <WorkshopButton disabled={more.loading} onClick={more.onLoadMore}>Load more</WorkshopButton>
        </div>
      )}
    </div>
  )
}
