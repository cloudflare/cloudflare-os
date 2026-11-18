import { XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import type { BannerColor } from '@gadgets/workshop-shared/api'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'

export type SiteBannerProps = {
  /** What the deployment says to everyone, as Markdown, whose links open elsewhere. */
  text: string
  /** The colour its administrator chose for it. */
  color: BannerColor
  /** Put away on this device, until it says something else. */
  onDismiss: () => void
}

// A soft tint under writing in its colour, so that it does not read as something gone wrong, or
// the brand in full. On the brand, which is as deep in dark as an accent is made there, white
// writing, as the mark's sparkle is.
const COLORS: Record<BannerColor, string> = {
  neutral: 'bg-kumo-tint text-kumo-default',
  info: 'bg-kumo-info-tint text-kumo-info',
  success: 'bg-kumo-success-tint text-kumo-success',
  warning: 'bg-kumo-warning-tint text-kumo-warning',
  danger: 'bg-kumo-danger-tint text-kumo-danger',
  brand: 'bg-kumo-brand text-white',
}

/**
 * What the deployment's administrator says to everyone (`ServerConfig.banner`), across the top of
 * the window, over the app and the sign-in page alike: in the middle, with the way to put it away
 * at its end. Its button is a size under the app's, as `Banner`'s is.
 */
export const SiteBanner = ({ text, color, onDismiss }: SiteBannerProps) => (
  <div
    role="region"
    aria-label="Announcement"
    className={cn(
      'flex shrink-0 items-start gap-2 p-1 ps-4 pt-[max(0.25rem,env(safe-area-inset-top))] text-sm leading-snug [--banner-button:calc(var(--control-size)-0.5rem)]',
      COLORS[color] ?? COLORS.info,
    )}
  >
    {/* As far in from its end as the button takes, so that what is said is in the window's middle. */}
    <div className="min-w-0 flex-1 ps-(--banner-button) py-[calc((var(--banner-button)-1lh)/2)] text-center wrap-break-word [&_a]:font-medium">
      <Markdown onTint>{text}</Markdown>
    </div>
    <Button
      variant="ghost"
      icon={<XIcon weight="bold" />}
      aria-label="Dismiss announcement"
      onClick={onDismiss}
      className="size-(--banner-button) shrink-0 text-current not-data-disabled:hover:bg-current/10"
    />
  </div>
)
