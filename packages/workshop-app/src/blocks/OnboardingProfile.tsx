import { EditableTitle } from '@gadgets/ui'
import { ProfilePicture } from './ProfilePicture'

export type OnboardingProfileProps = {
  name: string
  onNameChange: (name: string) => void
  /** The user's picture, once they have one. */
  avatarUrl?: string
  /** A picture is being kept, or taken away. */
  pictureBusy?: boolean
  onChoosePicture: (file: File) => void
  onRemovePicture: () => void
}

/**
 * Who the user is to others, as they are set up, as the profile settings start: their picture,
 * which opens the ways to change it, over the name they go by, renamed where it is.
 */
export const OnboardingProfile = ({ name, onNameChange, avatarUrl, pictureBusy, onChoosePicture, onRemovePicture }: OnboardingProfileProps) => (
  <div className="flex flex-col items-center gap-3 py-8 text-center">
    <ProfilePicture name={name.trim() || '?'} src={avatarUrl} busy={pictureBusy} onChoose={onChoosePicture} onRemove={onRemovePicture} />
    <div className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
      <EditableTitle value={name} aria-label="Display name" placeholder="Display name" className="text-center" onRename={onNameChange} />
    </div>
  </div>
)
