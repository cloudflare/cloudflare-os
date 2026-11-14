import { Avatar as BaseAvatar } from '@cloudflare/kumo/primitives/avatar'
import { cn } from '@cloudflare/kumo/utils'

export type AvatarProps = {
  /** Shown as initials when there is no image or it fails to load, and used as the accessible name. */
  name: string
  src?: string
  /** `sm` in a row or a button, `lg` heading the user's profile. */
  size?: 'sm' | 'lg'
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')

/** A user's picture, or their initials. */
export const Avatar = ({ name, src, size = 'sm' }: AvatarProps) => (
  <BaseAvatar.Root
    role="img"
    aria-label={name}
    className={cn(
      'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint font-medium text-kumo-default select-none',
      size === 'lg' ? 'size-24 text-3xl ring-1 ring-kumo-contrast/6' : 'size-7 text-xs',
    )}
  >
    {src && <BaseAvatar.Image src={src} alt="" className="size-full object-cover" />}
    <BaseAvatar.Fallback>{initials(name)}</BaseAvatar.Fallback>
  </BaseAvatar.Root>
)
