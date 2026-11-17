import { useRef } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { TrashIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { DropdownMenu } from '@/components/DropdownMenu'

export type ProfilePictureProps = {
  /** Whose picture it is, for their initials while there is none. */
  name: string
  src?: string
  /** A new picture is on its way, or the old one is going. */
  busy?: boolean
  onChoose: (file: File) => void
  /** Takes the picture away, which goes back to their initials. */
  onRemove: () => void
}

/**
 * The user's picture, large, which opens the ways to change it when clicked, as a workspace's
 * icon does: choosing an image from the device, and taking away the one there is.
 */
export const ProfilePicture = ({ name, src, busy = false, onChoose, onRemove }: ProfilePictureProps) => {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <DropdownMenu
        // In a span, so that it keeps its own size rather than taking the Button's size for an icon.
        icon={<span className="grid"><Avatar name={name} src={src} className={cn('size-20 text-2xl', busy && 'opacity-50')} /></span>}
        aria-label="Profile picture"
        triggerVariant="ghost"
        // A round surface when pointed at, whose room is taken back out, so that the picture is
        // where one that cannot be changed would be.
        triggerClassName="-m-1.5 h-auto w-auto p-1.5 not-data-disabled:hover:bg-kumo-contrast/5 data-popup-open:bg-kumo-contrast/5"
        keepTrigger
        align="center"
      >
        <DropdownMenu.Item icon={UploadSimpleIcon} disabled={busy} onSelect={() => input.current?.click()}>Upload</DropdownMenu.Item>
        <DropdownMenu.Item icon={TrashIcon} disabled={busy || !src} onSelect={onRemove}>Remove</DropdownMenu.Item>
      </DropdownMenu>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        // The menu's item is what is reached and named.
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Emptied, so that choosing the same image again is still a change.
          event.target.value = ''
          if (file) onChoose(file)
        }}
      />
    </>
  )
}
