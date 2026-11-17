import { useEffect, useState } from 'react'
import { PasswordForm } from '@/blocks/PasswordForm'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { hashPassword } from '@/rpc/passwordHash'
import { signOut } from '@/rpc/signOut'
import { messageOf } from './useAttempt'
import { SoonSwitch } from './SoonControls'

/** How the user signs in, and the way out. */
export const SecuritySettings = () => {
  const { api, user, reconnecting } = useApi()
  const notice = useConnectionNotice()
  // Whether there is a password to change: not for an account signed in to through another service.
  const [hasPassword, setHasPassword] = useState<boolean>()

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` asks.
    if (reconnecting) return
    let cancelled = false
    api.hasPasswordLogin().then(
      (has) => {
        if (!cancelled) setHasPassword(has)
      },
      // Not known, so not offered.
      () => {
        if (!cancelled) setHasPassword((current) => current ?? false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api, reconnecting])

  const changePassword = async (current: string, next: string) => {
    if (notice?.blocked()) return 'Not connected. Try again once the connection is back.'
    try {
      await api.changePassword(await hashPassword(user.id, current), await hashPassword(user.id, next))
    } catch (error) {
      return messageOf(error)
    }
  }

  return (
    <>
      <SettingsGroup title="Password">
        {hasPassword === undefined && <p role="status" className="appears-late py-4 text-kumo-subtle">Checking your sign-in method…</p>}
        {hasPassword === true && <PasswordForm onChange={changePassword} />}
        {hasPassword === false && (
          <SettingRow title="No password" description="You sign in through an identity provider, so there’s no password to change here." />
        )}
      </SettingsGroup>
      <SettingsGroup title="Sign-in" soon>
        <SettingRow title="Two-factor authentication" description="Require a code from an authenticator app when you sign in.">
          <SoonSwitch label="Two-factor authentication" />
        </SettingRow>
        <SettingRow title="Passkeys" description="Sign in with a fingerprint, face or security key instead of a password.">
          <Button>Add passkey</Button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Sessions">
        <SettingRow title="Active sessions" description="Browsers and devices signed in to your account. Sign out of any of them." soon>
          <Button>Manage sessions</Button>
        </SettingRow>
        <SettingRow title="Sign out" description="Sign out of your account in this browser. Running tasks continue.">
          <ConfirmMenu label="Sign out" title="Sign out?" description="You’ll need to sign in again to use the Workshop in this browser." confirmLabel="Sign out" onConfirm={signOut} />
        </SettingRow>
      </SettingsGroup>
    </>
  )
}
