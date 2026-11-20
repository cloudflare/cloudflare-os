import { TextField } from '@gadgets/ui'
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
  disabled?: boolean
}

/**
 * Who the user is to others, as they are set up: their picture, which opens the ways to change it
 * as it does in the settings, over the name they go by.
 */
export const OnboardingProfile = ({ name, onNameChange, avatarUrl, pictureBusy, onChoosePicture, onRemovePicture, disabled }: OnboardingProfileProps) => (
  <div className="flex flex-col items-center gap-6">
    <ProfilePicture name={name.trim() || '?'} src={avatarUrl} busy={pictureBusy} onChoose={onChoosePicture} onRemove={onRemovePicture} />
    <div className="flex w-full flex-col gap-1.5">
      <TextField
        label="Your name"
        value={name}
        onValueChange={onNameChange}
        placeholder="What should people call you?"
        autoComplete="name"
        maxLength={100}
        disabled={disabled}
      />
      <p className="px-1 text-sm text-kumo-subtle">How you appear to the people you work with.</p>
    </div>
  </div>
)
