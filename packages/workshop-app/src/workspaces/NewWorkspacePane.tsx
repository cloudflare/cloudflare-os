import { useState, type FormEvent } from 'react'
import { CaretLeftIcon } from '@phosphor-icons/react'
import { usePending } from '@/blocks/usePending'
import { Button } from '@/components/Button'
import { HeaderBubble } from '@/components/HeaderBubble'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useCreateWorkspace } from './WorkspacesContext'
import { workspaceLabel } from './workspaceLabel'

const PLACEHOLDER = 'Untitled workspace'

export type NewWorkspacePaneProps = {
  onBack: () => void
  /** The workspace has been made: open it. */
  onCreated: (workspaceId: string) => void
}

/**
 * Making a workspace on purpose, rather than by starting a chat: its title, typed where it will be
 * shown and on a folder that takes its initials as they are typed, then made with Enter or the
 * button. A blank title makes one the server names.
 */
export const NewWorkspacePane = ({ onBack, onCreated }: NewWorkspacePaneProps) => {
  const create = useCreateWorkspace()
  const connection = useConnectionNotice()
  const [title, setTitle] = useState('')
  // Why the last attempt made nothing.
  const [problem, setProblem] = useState<string>()
  const [pending, run] = usePending()
  useDocumentTitle('New workspace')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setProblem(undefined)
    if (pending || connection?.blocked()) return
    run(async () => {
      try {
        onCreated(await create(title.trim() || PLACEHOLDER))
      } catch (error) {
        setProblem(`Couldn’t create the workspace: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  return (
    <PageLayout
      header={(
        <HeaderBubble>
          <Button icon={CaretLeftIcon} onClick={onBack}>Workspaces</Button>
        </HeaderBubble>
      )}
    >
      {/* Centred in what is left beneath the header, as the home page's greeting is. */}
      <form
        onSubmit={submit}
        className="flex min-h-[calc(100dvh-var(--header-height,0px)-6rem)] flex-col items-center justify-center gap-2 text-center"
      >
        <WorkspaceIcon label={workspaceLabel(title || PLACEHOLDER)} />
        <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
          <input
            aria-label="Workspace title"
            value={title}
            placeholder={PLACEHOLDER}
            // Where `field-sizing` is not supported, about as wide as what is in it.
            size={Math.max(title.length || PLACEHOLDER.length, 1)}
            maxLength={200}
            autoFocus
            enterKeyHint="go"
            readOnly={pending}
            onChange={(event) => setTitle(event.target.value)}
            className="field-sizing-content max-w-full min-w-0 appearance-none rounded-xl border-0 bg-kumo-contrast/5 px-2.5 py-1 text-center outline-none placeholder:text-kumo-subtle"
          />
        </h1>
        <p className="text-base text-kumo-subtle">Its chats, gadgets and files stay together, and can be shared at once.</p>
        <Button type="submit" variant="primary" disabled={pending} className="mt-4">
          {pending ? 'Creating…' : 'Create workspace'}
        </Button>
        {problem && <p role="alert" className="text-base text-kumo-subtle">{problem}</p>}
      </form>
    </PageLayout>
  )
}
