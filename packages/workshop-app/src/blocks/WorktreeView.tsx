import { useState } from 'react'
import { CaretDownIcon, GitCommitIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { CodeBrowser, type CodeBrowserProps } from './CodeBrowser'

/** A commit an agent made in a worktree, as listed. */
export type WorktreeCommit = {
  id: string
  /** Its message's first line. */
  summary: string
  /** When, as the app says it: "5 min ago". */
  time: string
}

export type WorktreeViewProps = Omit<CodeBrowserProps, 'className' | 'empty'> & {
  changes:
    | { status: 'loading' }
    | { status: 'ready'; changedFiles: number; commits: WorktreeCommit[] }
}

const COUNT = new Intl.NumberFormat('en')
const plural = (count: number, one: string, many: string) => `${COUNT.format(count)} ${count === 1 ? one : many}`

/**
 * A worktree, beside the chat that works in it: what its agent has done to it since it was made,
 * in a line (the files changed, and its commits, which open into a list under it), then its code
 * as last kept (`CodeBrowser`), the changed files marked and first. Changes the chat is still
 * making show once they are kept, which the line under the summary says.
 */
export const WorktreeView = ({ changes, ...browser }: WorktreeViewProps) => {
  const [history, setHistory] = useState(false)
  const commits = changes.status === 'ready' ? changes.commits : []
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <div className="flex flex-col gap-1 px-2 pt-1">
        <div className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-kumo-default">
          {changes.status === 'loading' ? (
            <span role="status" className="appears-late text-kumo-subtle">Reading what changed…</span>
          ) : (
            <>
              <span className="appears flex items-center gap-2">
                {changes.changedFiles > 0 && <span aria-hidden="true" className="size-1.5 rounded-full bg-kumo-brand" />}
                {changes.changedFiles > 0 ? `${plural(changes.changedFiles, 'file', 'files')} changed` : 'Nothing changed yet'}
              </span>
              {commits.length > 0 && (
                <button
                  type="button"
                  aria-expanded={history}
                  onClick={() => setHistory((open) => !open)}
                  className="appears -mx-2 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-kumo-subtle outline-none hover:bg-kumo-fill hover:text-kumo-default focus-visible:ring-2 focus-visible:ring-kumo-ring"
                >
                  {plural(commits.length, 'commit', 'commits')}
                  <CaretDownIcon aria-hidden="true" weight="bold" className={cn('size-3 transition-[rotate] duration-150 motion-reduce:transition-none', history && 'rotate-180')} />
                </button>
              )}
            </>
          )}
        </div>
        <p className="text-xs/4 text-kumo-subtle">As last kept. What the chat is changing now shows here once it’s kept.</p>
      </div>
      {history && commits.length > 0 && (
        <ol aria-label="Commits" className="appears flex max-h-48 shrink-0 flex-col overflow-y-auto rounded-2xl bg-kumo-base p-1.5 ring-1 ring-kumo-line">
          {commits.map((commit) => (
            <li key={commit.id} className="flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-sm/5">
              <GitCommitIcon aria-hidden="true" className="size-4 shrink-0 text-kumo-subtle" />
              <span className="min-w-0 flex-1 truncate text-kumo-default" title={commit.summary}>{commit.summary}</span>
              <span className="shrink-0 font-mono text-xs text-kumo-subtle">{commit.id.slice(0, 7)}</span>
              <span className="hidden shrink-0 text-xs text-kumo-subtle tabular-nums sm:inline">{commit.time}</span>
            </li>
          ))}
        </ol>
      )}
      <CodeBrowser {...browser} empty="It has no files yet." className="h-auto min-h-0 flex-1" />
    </div>
  )
}
