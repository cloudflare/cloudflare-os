import { useState } from 'react'
import { ProfilePicture } from '@/blocks/ProfilePicture'
import { Button, EditableTitle, type SaveOutcome, SettingField, SettingRow, SettingsGroup } from '@gadgets/ui'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { avatarImage } from './avatarImage'
import { ownAvatar } from './OwnAvatar'
import { messageOf, useAttempt } from './useAttempt'
import { useOwnAvatar } from './useOwnAvatar'
import { useProfileSettings } from './useProfileSettings'

/** Who the user is to others: their picture and their name, changed where they are shown, and the addresses that go with them. */
export const ProfileSettings = () => {
  const { api, user } = useApi()
  const { displayName, commitEmail } = useProfileSettings()
  const notice = useConnectionNotice()
  const avatarUrl = useOwnAvatar()
  const [busy, setBusy] = useState(false)
  const { problem, attempt } = useAttempt()

  const setPicture = async (what: string, picture: () => Promise<Uint8Array | null>) => {
    setBusy(true)
    await attempt(what, async () => {
      const bytes = await picture()
      await api.setAvatar(bytes)
      ownAvatar.set(user.id, bytes)
    })
    setBusy(false)
  }

  // A field keeps what could not be saved, under why; nothing is tried while the connection is down.
  const save = async (action: () => Promise<unknown>): Promise<SaveOutcome> => {
    if (notice?.blocked()) return { saved: false }
    try {
      await action()
      return { saved: true }
    } catch (error) {
      return { saved: false, problem: messageOf(error) }
    }
  }

  return (
    <>
      {/* As a workspace's page starts: the picture, which opens the ways to change it, over the name, renamed where it is. */}
      <div className="flex flex-col items-center gap-2 pt-4 text-center">
        <ProfilePicture
          name={user.name}
          src={avatarUrl}
          busy={busy}
          onChoose={(file) => void setPicture('change your picture', () => avatarImage(file))}
          onRemove={() => void setPicture('remove your picture', async () => null)}
        />
        <div className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
          <EditableTitle
            value={displayName.value}
            aria-label={displayName.title}
            placeholder={displayName.placeholder}
            className="text-center"
            onRename={(name) => void attempt('change your display name', () => displayName.set(name))}
          />
        </div>
        {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
      </div>
      <SettingsGroup title="Identity">
        <SettingRow title="User ID" description="Your unique ID on this deployment. Others use it to invite you to a workspace.">
          <span className="max-w-full truncate text-kumo-subtle select-all">{user.id}</span>
        </SettingRow>
        <SettingRow title="Sign-in email" description="Used to sign in and for emails about your account." soon>
          <Button>Change</Button>
        </SettingRow>
        <SettingField
          title={commitEmail.title}
          description={commitEmail.description}
          value={commitEmail.value}
          optional={commitEmail.optional}
          type={commitEmail.type}
          placeholder={commitEmail.placeholder}
          autoComplete="email"
          onSave={(email) => save(() => commitEmail.set(email))}
        />
      </SettingsGroup>
      <SettingsGroup title="Your data" soon>
        <SettingRow title="Export data" description="Download everything in your workspaces as files.">
          <Button>Export</Button>
        </SettingRow>
        <SettingRow title="Delete account" description="Permanently delete your account and every workspace you own. This can’t be undone.">
          <Button variant="danger">Delete account</Button>
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
