import { Badge } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowUpRightIcon, GitBranchIcon } from '@phosphor-icons/react'
import { CARD } from '@/components/Card'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'

export type OutputCardProps = {
  title: string
  kind: 'gadget' | 'worktree'
  /** Created in this chat and not accepted yet. */
  draft?: boolean
  /** What the gadget is, when its blueprint says; otherwise it reads as an app. */
  format?: { noun: string; icon: FormatIconName }
  onOpen: () => void
}

const caption = ({ kind, draft, format }: Pick<OutputCardProps, 'kind' | 'draft' | 'format'>) => {
  if (kind === 'worktree') return 'Worktree · Click to open its code'
  const noun = format?.noun ?? 'App'
  return draft ? `New ${noun.toLowerCase()} · Click to preview` : `${noun} · Click to open`
}

/** Something the agent made that can be opened: a document, an app, a checkout of code. */
export const OutputCard = ({ title, kind, draft, format, onOpen }: OutputCardProps) => (
  <button
    type="button"
    onClick={onOpen}
    className={cn(CARD, 'group flex w-fit max-w-[min(100%,28rem)] items-center gap-3 p-2 pe-4 text-left text-base/5 hover:bg-kumo-tint')}
  >
    <span className="grid size-14 shrink-0 place-items-center rounded-[13px] bg-kumo-fill text-kumo-subtle">
      {kind === 'worktree' ? <GitBranchIcon aria-hidden="true" className="size-6" /> : <FormatIcon name={format?.icon} className="size-6" />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate font-medium text-kumo-default">{title}</span>
      <span className="flex min-w-0 items-center gap-2 text-sm text-kumo-subtle">
        {draft && <Badge variant="neutral">Draft</Badge>}
        <span className="truncate">{caption({ kind, draft, format })}</span>
      </span>
    </span>
    <ArrowUpRightIcon aria-hidden="true" weight="bold" className="size-4 shrink-0 text-kumo-subtle group-hover:text-kumo-default" />
  </button>
)
