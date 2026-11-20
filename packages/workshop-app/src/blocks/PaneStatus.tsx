import { CheckCircleIcon, WarningCircleIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@gadgets/ui'
import { ShimmerText } from '@/components/ShimmerText'

export type PaneStatusProps = {
  /** Under way, done, or gone wrong, which its colour and icon say. */
  tone: 'working' | 'done' | 'failed'
  /** What it is, in a few words: "Exporting to PDF…". */
  title: string
  /** Why it went wrong. */
  description?: string
  /** What can be done next from here, such as opening what was made. */
  action?: { label: string; onSelect: () => void }
  /** Puts it away; something under way cannot be. */
  onDismiss?: () => void
}

/**
 * What became of something asked for from the pane's menus, such as an export, floated over the
 * foot of what the pane shows, which goes on being used under it. It is said while it is under
 * way, then that it was done or why it was not, with the way on from there.
 */
export const PaneStatus = ({ tone, title, description, action, onDismiss }: PaneStatusProps) => (
  <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
    <div
      role={tone === 'failed' ? 'alert' : 'status'}
      className={cn(
        'appears pointer-events-auto flex max-w-full min-w-0 items-start gap-2.5 rounded-[1.375rem] p-1.5 ps-3.5 text-base leading-snug shadow-lg ring-1',
        tone === 'failed' ? 'bg-kumo-danger-tint text-kumo-danger ring-kumo-danger/20' : 'bg-kumo-base text-kumo-default ring-kumo-contrast/6',
      )}
    >
      {tone !== 'working' && (
        <span className="flex h-(--control-size) shrink-0 items-center">
          {tone === 'done'
            ? <CheckCircleIcon aria-hidden="true" weight="fill" className="size-5 text-kumo-success" />
            : <WarningCircleIcon aria-hidden="true" className="size-5" />}
        </span>
      )}
      <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5 py-[calc((var(--control-size)-1lh)/2)]', tone === 'working' && 'pe-2')}>
        <p className="font-medium wrap-break-word">{tone === 'working' ? <ShimmerText>{title}</ShimmerText> : title}</p>
        {description && <p className="text-sm wrap-break-word">{description}</p>}
      </div>
      {action && <Button onClick={action.onSelect}>{action.label}</Button>}
      {onDismiss && tone !== 'working' && (
        <Button
          variant="ghost"
          icon={<XIcon weight="bold" />}
          aria-label="Dismiss"
          onClick={onDismiss}
          className={tone === 'failed' ? 'text-kumo-danger not-data-disabled:hover:bg-kumo-danger/12' : 'text-kumo-subtle'}
        />
      )}
    </div>
  </div>
)
