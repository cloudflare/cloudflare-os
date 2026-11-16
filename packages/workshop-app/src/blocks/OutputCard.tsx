import { Badge } from '@cloudflare/kumo'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowUpRightIcon, GitBranchIcon } from '@phosphor-icons/react'
import { CARD } from '@/components/Card'
import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { GoogleFileIcon } from '@/components/GoogleFileIcon'
import { LinkButton } from '@/components/LinkButton'
import type { WorkspaceColor } from '@/components/workspaceLook'
import type { ConnectedFileKind } from '@/files/connectedFile'

export type OutputCardProps = {
  title: string
  kind: 'gadget' | 'worktree'
  /** It is a Google file the agent created, which opens drawn as itself. */
  file?: ConnectedFileKind
  /** Created in this chat and not accepted yet. */
  draft?: boolean
  /** What the gadget is, when its blueprint says; otherwise it reads as an app. */
  format?: { noun: string; icon: FormatIconName }
  /** The colour its mark is drawn in, as chosen for the gadget; none, ink. */
  color?: WorkspaceColor
  /** The output's own page, so that it can be opened in another tab. */
  href?: string
  /** Opens it in place, such as beside the chat. */
  onOpen: () => void
}

const FILE_NOUNS: Record<ConnectedFileKind, string> = { document: 'Google Doc', spreadsheet: 'Google Sheet', presentation: 'Google Slides' }

const caption = ({ kind, file, draft, format }: Pick<OutputCardProps, 'kind' | 'file' | 'draft' | 'format'>) => {
  if (file) return `${FILE_NOUNS[file]} · Click to open`
  if (kind === 'worktree') return 'Worktree · Click to open its code'
  const noun = format?.noun ?? 'App'
  return draft ? `New ${noun.toLowerCase()} · Click to preview` : `${noun} · Click to open`
}

/** Something the agent made that can be opened: a document, an app, a checkout of code, a Google file. */
export const OutputCard = ({ title, kind, file, draft, format, color, href, onOpen }: OutputCardProps) => (
  <LinkButton
    href={href}
    onClick={onOpen}
    className={cn(CARD, 'group flex w-fit max-w-[min(100%,28rem)] min-w-[min(100%,20rem)] items-center gap-3 p-2 pe-4 text-left text-base/5 hover:bg-kumo-tint')}
  >
    <span className="grid size-14 shrink-0 place-items-center rounded-[13px] bg-kumo-fill text-kumo-subtle">
      {file ? <GoogleFileIcon kind={file} className="size-7" />
        : kind === 'worktree' ? <GitBranchIcon aria-hidden="true" className="size-6" /> : <FormatIcon name={format?.icon} color={color} className="size-6" />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate font-medium text-kumo-default">{title}</span>
      <span className="flex min-w-0 items-center gap-2 text-sm text-kumo-subtle">
        {draft && <Badge variant="neutral">Draft</Badge>}
        <span className="truncate">{caption({ kind, file, draft, format })}</span>
      </span>
    </span>
    <ArrowUpRightIcon aria-hidden="true" weight="bold" className="size-4 shrink-0 text-kumo-subtle group-hover:text-kumo-default" />
  </LinkButton>
)
