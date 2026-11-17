import { useState } from 'react'
import { validateCommitEmail } from '@gadgets/workshop-shared/api'
import { ProfilePicture } from '@/blocks/ProfilePicture'
import { SettingField, type SaveOutcome } from '@/blocks/SettingField'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { EditableTitle } from '@/components/EditableTitle'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { avatarImage } from './avatarImage'
import { ownAvatar } from './OwnAvatar'
import { messageOf, useAttempt } from './useAttempt'
import { useOwnAvatar } from './useOwnAvatar'

/** Who the user is to others: their picture and their name, changed where they are shown, and the addresses that go with them. */
export const ProfileSettings = () => {
  const { api, user, userChanged } = useApi()
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
            value={user.name}
            aria-label="Display name"
            placeholder="Display name"
            className="text-center"
            onRename={(name) => void attempt('change your display name', async () => {
              await api.setOwnDisplayName(name)
              userChanged({ ...user, name })
            })}
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
          title="Commit email"
          description="The author email on your changes. Leave empty to use one generated from your user ID."
          value={user.commitEmail ?? ''}
          optional
          type="email"
          placeholder="name@example.com"
          autoComplete="email"
          onSave={(email) => save(async () => {
            if (email) validateCommitEmail(email)
            await api.setOwnCommitEmail(email || null)
            userChanged({ ...user, commitEmail: email || undefined })
          })}
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
