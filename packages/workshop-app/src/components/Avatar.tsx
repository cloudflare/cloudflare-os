import { Avatar as BaseAvatar } from '@cloudflare/kumo/primitives/avatar'
import { cn } from '@cloudflare/kumo/utils'

export type AvatarProps = {
  /** Shown as initials when there is no image or it fails to load, and used as the accessible name. */
  name: string
  src?: string
  /** `sm` in a row or a button, `lg` heading the user's profile. */
  size?: 'sm' | 'lg'
  /** The size for a line of a menu, beside its text. */
  small?: boolean
  /** For the surface it is on, such as a fill that shows on one that is tinted. */
  className?: string
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')

/** A user's picture, or their initials. */
export const Avatar = ({ name, src, size = 'sm', small, className }: AvatarProps) => (
  <BaseAvatar.Root
    role="img"
    aria-label={name}
    className={cn(
      'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint font-medium text-kumo-default select-none',
      small ? 'size-5 text-[0.5625rem]' : size === 'lg' ? 'size-24 text-3xl ring-1 ring-kumo-contrast/6' : 'size-7 text-xs',
      className,
    )}
  >
    {src && <BaseAvatar.Image src={src} alt="" className="size-full object-cover" />}
    <BaseAvatar.Fallback>{initials(name)}</BaseAvatar.Fallback>
  </BaseAvatar.Root>
)
