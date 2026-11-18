import { WarningCircleIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from './Button'

export type BannerProps = {
  /** What is wrong, in a few words. */
  title: string
  /** What there is to do about it. */
  description?: string
  /** The way to do that from here. */
  action?: { label: string; disabled?: boolean; onSelect: () => void }
  /**
   * What it is: something that went wrong (`danger`), or something waiting on the reader that
   * nothing went wrong in (`warning`), in the colour of a caution, its writing the page's own.
   */
  tone?: 'danger' | 'warning'
}

/**
 * Something wrong, said across what it is in: on a surface of its own in the colour of what went
 * wrong, rounded as the app's other surfaces are, with the way to put it right at its end where
 * there is one. That is a button a shade deeper than the banner: its colour laid thinly over it,
 * under writing in the banner's own. Kumo's own banner is squarer, and its action a button of a
 * full red, so this is drawn here from Kumo's colours.
 *
 * The button is in the banner's top corner, as far from its top as from its side, and fully
 * round as the app's buttons are. The icon and the title are level with the button's
 * middle, with what there is to do under the title.
 */
export const Banner = ({ title, description, action, tone = 'danger' }: BannerProps) => (
  <div
    role={tone === 'danger' ? 'alert' : 'status'}
    // As round as the app's other surfaces, or as what it is in says a surface in it is (a
    // dialog). The button is a size under the app's, as it is part of what the banner says.
    className={cn(
      'flex items-start gap-3 rounded-[var(--surface-radius,1.5rem)] p-2 ps-4 text-base leading-snug [--banner-button:calc(var(--control-size)-0.25rem)]',
      tone === 'danger' ? 'bg-kumo-danger-tint text-kumo-danger' : 'bg-kumo-warning-tint text-kumo-default',
    )}
  >
    <span className={cn('flex h-(--banner-button) shrink-0 items-center', tone === 'warning' && 'text-kumo-warning')}>
      <WarningCircleIcon aria-hidden="true" className="size-5" />
    </span>
    {/* Its first line where the middle of the button is, and as far from the banner's foot. */}
    <div className="flex min-w-0 flex-1 flex-col gap-1 py-[calc((var(--banner-button)-1lh)/2)]">
      <p className="font-medium wrap-anywhere">{title}</p>
      {description && <p className="text-sm wrap-anywhere">{description}</p>}
    </div>
    {action && (
      <Button
        variant="ghost"
        disabled={action.disabled}
        onClick={action.onSelect}
        className={cn(
          'h-(--banner-button) px-3.5 text-sm',
          tone === 'danger'
            ? 'bg-kumo-danger/12 text-kumo-danger not-data-disabled:hover:bg-kumo-danger/20'
            : 'bg-kumo-warning/20 text-kumo-default not-data-disabled:hover:bg-kumo-warning/30',
        )}
      >
        {action.label}
      </Button>
    )}
  </div>
)
