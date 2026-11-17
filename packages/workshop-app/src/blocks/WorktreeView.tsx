import { CodeBrowser, type CodeBrowserCommit, type CodeBrowserProps } from './CodeBrowser'

export type WorktreeViewProps = Omit<CodeBrowserProps, 'className' | 'empty' | 'history' | 'frame'> & {
  changes:
    | { status: 'loading' }
    | { status: 'ready'; changedFiles: number; commits: CodeBrowserCommit[] }
  /** What is being looked at: `since` for everything changed since it was made, a commit's id, or none for its code as it is. */
  comparing?: string
  onCompare: (id: string | undefined) => void
  /** The id `comparing` takes for everything changed since it was made. */
  since: string
}

/**
 * A worktree, beside the chat that works in it, as last kept (`CodeBrowser`, filling the pane). Its
 * history leads with everything its agent changed since it was made, which is what it opens to
 * where there is any, then each of its commits; or its code as it is. Changes the chat is still
 * making show once they are kept, which the status line says.
 */
export const WorktreeView = ({ changes, comparing, onCompare, since, ...browser }: WorktreeViewProps) => {
  const sinceMade: CodeBrowserCommit[] = changes.status === 'ready' && changes.changedFiles > 0
    ? [{ id: since, summary: 'All its changes', time: 'Since it was made' }]
    : []
  return (
    <CodeBrowser
      {...browser}
      frame="pane"
      empty="It has no files yet."
      history={{
        commits: changes.status === 'ready' ? { status: 'ready', commits: [...sinceMade, ...changes.commits] } : changes,
        comparing,
        onCompare,
      }}
      note={browser.note ?? 'As last kept'}
    />
  )
}
