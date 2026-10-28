import { Avatar as BaseAvatar } from '@cloudflare/kumo/primitives/avatar'

export type AvatarProps = {
  /** Shown as initials when there is no image or it fails to load, and used as the accessible name. */
  name: string
  src?: string
}

const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase())
    .join('')

/** A user's picture, or their initials. */
export const Avatar = ({ name, src }: AvatarProps) => (
  <BaseAvatar.Root
    role="img"
    aria-label={name}
    className="inline-flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-kumo-tint text-xs font-medium text-kumo-default select-none"
  >
    {src && <BaseAvatar.Image src={src} alt="" className="size-full object-cover" />}
    <BaseAvatar.Fallback>{initials(name)}</BaseAvatar.Fallback>
  </BaseAvatar.Root>
)
