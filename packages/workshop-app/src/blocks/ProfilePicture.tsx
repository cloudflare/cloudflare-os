import { useRef } from 'react'
import { CameraIcon, ImageIcon, TrashIcon } from '@phosphor-icons/react'
import { Avatar } from '@/components/Avatar'
import { DropdownMenu } from '@/components/DropdownMenu'

export type ProfilePictureProps = {
  /** Whose it is, whose initials stand in while there is none. */
  name: string
  picture?: string
  /** A new one is under way, which dims the one shown. */
  pending?: boolean
  /** A file was chosen to be the picture. */
  onChoose: (file: File) => void
  /** Takes it away; absent while there is none. */
  onRemove?: () => void
}

/**
 * The user's picture, large, heading their profile, or their initials while they have none; a
 * camera at its foot opens a menu to choose another from this device or take it away.
 */
export const ProfilePicture = ({ name, picture, pending, onChoose, onRemove }: ProfilePictureProps) => {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="relative">
      <span className={pending ? 'opacity-50 transition-opacity' : 'transition-opacity'}>
        <Avatar name={name} src={picture} size="lg" />
      </span>
      <span className="absolute -end-1 -bottom-1">
        <DropdownMenu
          icon={<CameraIcon weight="fill" />}
          aria-label="Change picture"
          triggerClassName="size-8 rounded-full bg-kumo-base text-kumo-default shadow-[0_1px_3px_rgb(0_0_0/0.12)] ring-1 ring-kumo-line [&_svg]:size-4"
          align="start"
          disabled={pending}
        >
          {/* In the menu's own click, which the browser lets open a file dialog. */}
          <DropdownMenu.Item icon={ImageIcon} onSelect={() => input.current?.click()}>Choose a picture…</DropdownMenu.Item>
          {onRemove && <DropdownMenu.Item icon={TrashIcon} danger onSelect={onRemove}>Remove picture</DropdownMenu.Item>}
        </DropdownMenu>
      </span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) onChoose(file)
        }}
      />
    </div>
  )
}
